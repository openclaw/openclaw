/**
 * Enhanced snapshot module using script-based interactive element detection.
 * Based on AutoGen's approach with multiple heuristics for better coverage.
 *
 * This module provides an alternative to the standard Playwright snapshot methods
 * by using injected JavaScript to detect interactive elements with:
 * - Cursor-based detection (catches custom interactive elements)
 * - Bounding boxes stored upfront (faster access)
 * - Topmost visibility checking (more accurate)
 * - Multiple detection heuristics (better coverage)
 */

import type { Page, Locator } from "playwright-core";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRoleSnapshotFromAriaSnapshot,
  getRoleSnapshotStats,
  type RoleRefMap,
  type RoleSnapshotOptions,
} from "./pw-role-snapshot.js";
import { ensurePageState, getPageForTargetId, storeRoleRefsForTarget } from "./pw-session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load the page script
let pageScriptContent: string | null = null;
function getPageScript(): string {
  if (pageScriptContent === null) {
    const scriptPath = join(__dirname, "page-script-enhanced.js");
    pageScriptContent = readFileSync(scriptPath, "utf-8");
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return pageScriptContent!;
}

/**
 * Type definitions for enhanced detection results
 */
export type DOMRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type InteractiveRegion = {
  tag_name: string;
  role: string;
  aria_name: string;
  v_scrollable: boolean;
  rects: DOMRectangle[];
};

export type VisualViewport = {
  height: number;
  width: number;
  offsetLeft: number;
  offsetTop: number;
  pageLeft: number;
  pageTop: number;
  scale: number;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
};

export type EnhancedSnapshotResult = {
  snapshot: string;
  refs: RoleRefMap;
  stats: { lines: number; chars: number; refs: number; interactive: number };
  interactiveRegions: Record<string, InteractiveRegion>;
  viewport: VisualViewport;
  visibleText: string;
};

// Track which pages have had the script injected
const pagesWithScript = new WeakSet<Page>();

/**
 * Ensure the enhanced detection script is injected into the page.
 * Uses addInitScript for persistence across navigations.
 * @throws Error if script injection fails after all attempts
 */
async function ensureScriptInjected(page: Page): Promise<void> {
  if (pagesWithScript.has(page)) {
    // Script already injected, just verify it's available
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const isAvailable = (await page.evaluate(
        "typeof OpenClawEnhancedDetection !== 'undefined'",
      )) as boolean;
      if (isAvailable) {
        return;
      }
      // Script not available, re-inject
      pagesWithScript.delete(page);
    } catch {
      // Evaluation failed, re-inject
      pagesWithScript.delete(page);
    }
  }

  const script = getPageScript();
  let lastError: unknown;

  try {
    // Add as init script so it persists across navigations
    await page.addInitScript(script);
    // Also evaluate immediately to make it available now
    await page.evaluate(script);
    // Verify it's available
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const isAvailable = (await page.evaluate(
      "typeof OpenClawEnhancedDetection !== 'undefined'",
    )) as boolean;
    if (isAvailable) {
      pagesWithScript.add(page);
      return;
    }
    lastError = new Error("OpenClawEnhancedDetection not available after injection");
  } catch (err) {
    lastError = err;
  }

  // If addInitScript fails, try direct evaluation
  try {
    await page.evaluate(script);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const isAvailable = (await page.evaluate(
      "typeof OpenClawEnhancedDetection !== 'undefined'",
    )) as boolean;
    if (isAvailable) {
      pagesWithScript.add(page);
      return;
    }
    lastError = new Error("OpenClawEnhancedDetection not available after direct evaluation");
  } catch (err) {
    lastError = err;
  }

  // All injection attempts failed - throw clear error
  throw new Error(
    `Failed to inject enhanced detection script: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError },
  );
}

/**
 * Get interactive regions using the enhanced script-based detection.
 */
export async function getInteractiveRegionsViaScript(opts: {
  cdpUrl: string;
  targetId?: string;
  locator?: Locator;
}): Promise<Record<string, InteractiveRegion>> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await ensureScriptInjected(page);

  // Evaluate script within locator context if provided, otherwise use document
  const result = opts.locator
    ? ((await opts.locator.evaluate((el: Element) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (window as any).OpenClawEnhancedDetection.getInteractiveRects(el);
      })) as Record<string, unknown>)
    : ((await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (window as any).OpenClawEnhancedDetection.getInteractiveRects(document);
      })) as Record<string, unknown>);

  const regions: Record<string, InteractiveRegion> = {};
  for (const [key, value] of Object.entries(result)) {
    const v = value as {
      tag_name?: string;
      role?: string;
      aria_name?: string;
      v_scrollable?: boolean;
      rects?: Array<{
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        top?: number;
        right?: number;
        bottom?: number;
        left?: number;
      }>;
    };

    if (v.tag_name && v.role !== undefined && v.aria_name !== undefined) {
      const rects: DOMRectangle[] = [];
      for (const rect of v.rects ?? []) {
        if (
          typeof rect.x === "number" &&
          typeof rect.y === "number" &&
          typeof rect.width === "number" &&
          typeof rect.height === "number"
        ) {
          rects.push({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top ?? rect.y,
            right: rect.right ?? rect.x + rect.width,
            bottom: rect.bottom ?? rect.y + rect.height,
            left: rect.left ?? rect.x,
          });
        }
      }

      regions[key] = {
        tag_name: v.tag_name,
        role: v.role,
        aria_name: v.aria_name,
        v_scrollable: Boolean(v.v_scrollable),
        rects,
      };
    }
  }

  return regions;
}

/**
 * Get visual viewport information.
 */
export async function getVisualViewportViaScript(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<VisualViewport> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await ensureScriptInjected(page);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const result = (await page.evaluate("OpenClawEnhancedDetection.getVisualViewport();")) as Record<
    string,
    number
  >;

  return {
    height: result.height ?? 0,
    width: result.width ?? 0,
    offsetLeft: result.offsetLeft ?? 0,
    offsetTop: result.offsetTop ?? 0,
    pageLeft: result.pageLeft ?? 0,
    pageTop: result.pageTop ?? 0,
    scale: result.scale ?? 0,
    clientWidth: result.clientWidth ?? 0,
    clientHeight: result.clientHeight ?? 0,
    scrollWidth: result.scrollWidth ?? 0,
    scrollHeight: result.scrollHeight ?? 0,
  };
}

/**
 * Get visible text from viewport.
 */
export async function getVisibleTextViaScript(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<string> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await ensureScriptInjected(page);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const result = (await page.evaluate("OpenClawEnhancedDetection.getVisibleText();")) as string;

  return String(result ?? "");
}

/**
 * Get focused element ID.
 */
export async function getFocusedElementIdViaScript(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<string | null> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await ensureScriptInjected(page);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const result = (await page.evaluate("OpenClawEnhancedDetection.getFocusedElementId();")) as
    | string
    | null;

  return result;
}

/**
 * Create a role-based snapshot from enhanced interactive regions.
 * Converts the script-detected regions into OpenClaw's role snapshot format.
 */
function buildRoleSnapshotFromInteractiveRegions(
  regions: Record<string, InteractiveRegion>,
  options: RoleSnapshotOptions = {},
): { snapshot: string; refs: RoleRefMap } {
  const refs: RoleRefMap = {};
  const lines: string[] = [];
  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "treeitem",
  ]);

  let refCounter = 0;
  const nextRef = () => {
    refCounter += 1;
    return `e${refCounter}`;
  };

  for (const [_elementId, region] of Object.entries(regions)) {
    const role = region.role.toLowerCase();
    const name = region.aria_name.trim();

    // Filter by interactive if requested
    if (options.interactive && !INTERACTIVE_ROLES.has(role)) {
      continue;
    }

    const ref = nextRef();
    refs[ref] = {
      role,
      ...(name ? { name } : {}),
    };

    const roleDisplay = role || "element";
    const nameDisplay = name ? ` "${name}"` : "";
    const tagDisplay = region.tag_name ? ` (${region.tag_name})` : "";
    const scrollableDisplay = region.v_scrollable ? " [scrollable]" : "";
    const rectsDisplay =
      region.rects.length > 0
        ? ` [${region.rects.length} rect${region.rects.length > 1 ? "s" : ""}]`
        : "";

    lines.push(
      `- ${roleDisplay}${nameDisplay}${tagDisplay} [ref=${ref}]${scrollableDisplay}${rectsDisplay}`,
    );
  }

  const snapshot = lines.length > 0 ? lines.join("\n") : "(no interactive elements)";
  return { snapshot, refs };
}

/**
 * Enhanced snapshot using script-based detection.
 * This is an alternative to snapshotRoleViaPlaywright that uses
 * AutoGen-style script injection for better element detection.
 */
export async function snapshotEnhancedViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  selector?: string;
  frameSelector?: string;
  options?: RoleSnapshotOptions;
}): Promise<EnhancedSnapshotResult> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);
  await ensureScriptInjected(page);

  // Build locator for scoping (same pattern as snapshotRoleViaPlaywright)
  const frameSelector = opts.frameSelector?.trim() || "";
  const selector = opts.selector?.trim() || "";
  const locator = frameSelector
    ? selector
      ? page.frameLocator(frameSelector).locator(selector)
      : page.frameLocator(frameSelector).locator(":root")
    : selector
      ? page.locator(selector)
      : page.locator(":root");

  // Get interactive regions via script, scoped to locator
  const interactiveRegions = await getInteractiveRegionsViaScript({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    locator,
  });

  // Get viewport info
  const viewport = await getVisualViewportViaScript({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });

  // Get visible text
  const visibleText = await getVisibleTextViaScript({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });

  // Build role snapshot from regions
  const { snapshot, refs } = buildRoleSnapshotFromInteractiveRegions(
    interactiveRegions,
    opts.options,
  );

  // Store refs for later use
  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs,
    frameSelector: opts.frameSelector?.trim() || undefined,
    mode: "role",
  });

  const stats = getRoleSnapshotStats(snapshot, refs);

  return {
    snapshot,
    refs,
    stats,
    interactiveRegions,
    viewport,
    visibleText,
  };
}

/**
 * Hybrid snapshot: combines Playwright's ariaSnapshot with enhanced script detection.
 * Uses Playwright as primary, enhances with script-based detection for custom elements.
 */
export async function snapshotHybridViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  selector?: string;
  frameSelector?: string;
  options?: RoleSnapshotOptions;
}): Promise<{
  snapshot: string;
  refs: RoleRefMap;
  stats: { lines: number; chars: number; refs: number; interactive: number };
  enhancedRegions?: Record<string, InteractiveRegion>;
}> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);

  // Get Playwright's aria snapshot (primary method)
  const frameSelector = opts.frameSelector?.trim() || "";
  const selector = opts.selector?.trim() || "";
  const locator = frameSelector
    ? selector
      ? page.frameLocator(frameSelector).locator(selector)
      : page.frameLocator(frameSelector).locator(":root")
    : selector
      ? page.locator(selector)
      : page.locator(":root");

  const ariaSnapshot = await locator.ariaSnapshot();
  const built = buildRoleSnapshotFromAriaSnapshot(String(ariaSnapshot ?? ""), opts.options);

  // Get enhanced regions for additional elements (scoped to same locator)
  await ensureScriptInjected(page);
  const enhancedRegions = await getInteractiveRegionsViaScript({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    locator,
  });

  // Merge: use Playwright's refs as primary, add any missing from enhanced detection
  const mergedRefs = { ...built.refs };
  let mergedLines = built.snapshot.split("\n");

  // Find the maximum numeric value from existing e{n} refs to avoid collisions
  const findNextRef = (): string => {
    const existingENums = Object.keys(mergedRefs)
      .map((ref) => {
        const match = ref.match(/^e(\d+)$/);
        return match ? Number.parseInt(match[1], 10) : 0;
      })
      .filter((n) => n > 0);
    const maxNum = existingENums.length > 0 ? Math.max(...existingENums) : 0;
    return `e${maxNum + 1}`;
  };

  // Find elements in enhanced regions that aren't in Playwright's snapshot
  const existingRefs = new Set(Object.keys(built.refs));
  for (const [_elementId, region] of Object.entries(enhancedRegions)) {
    const role = region.role.toLowerCase();
    const name = region.aria_name.trim();

    // Check if this element is already in the snapshot
    const alreadyExists = Array.from(existingRefs).some((ref) => {
      const refData = built.refs[ref];
      return refData?.role === role && refData?.name === name;
    });

    if (!alreadyExists && region.rects.length > 0) {
      // Add missing element with collision-safe ref
      const ref = findNextRef();
      mergedRefs[ref] = {
        role,
        ...(name ? { name } : {}),
      };

      const roleDisplay = role || "element";
      const nameDisplay = name ? ` "${name}"` : "";
      mergedLines.push(`- ${roleDisplay}${nameDisplay} [ref=${ref}] [enhanced]`);
    }
  }

  const mergedSnapshot = mergedLines.join("\n");
  const stats = getRoleSnapshotStats(mergedSnapshot, mergedRefs);

  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: mergedRefs,
    frameSelector: frameSelector || undefined,
    mode: "role",
  });

  return {
    snapshot: mergedSnapshot,
    refs: mergedRefs,
    stats,
    enhancedRegions,
  };
}
