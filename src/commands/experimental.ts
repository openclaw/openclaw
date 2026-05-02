import { readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { FIELD_LABELS } from "../config/schema.labels.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { danger, info, success } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";

// Registry of experimental flags. Add a new entry when shipping a new
// `experimental.*` config flag you want to expose in the picker.
export const EXPERIMENTAL_FLAGS = [
  {
    path: "tools.experimental.planTool",
    summary: "Structured update_plan tool for multi-step work outside strict-agentic runs.",
  },
  {
    path: "agents.defaults.experimental.localModelLean",
    summary: "Drop heavyweight default tools for weaker or smaller local model backends.",
  },
  {
    path: "agents.defaults.memorySearch.experimental.sessionMemory",
    summary: "Index session transcripts into memory search (larger index churn).",
  },
] as const;

type FlagState = { path: string; segments: string[]; label: string; summary: string; on: boolean };

function readBool(root: unknown, segments: readonly string[]): boolean {
  let cur: unknown = root;
  for (const s of segments) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return false;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur === true;
}

function setAt(root: Record<string, unknown>, segments: readonly string[], value: boolean): void {
  let cur = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const s = segments[i];
    const next = cur[s];
    if (!next || typeof next !== "object" || Array.isArray(next)) cur[s] = {};
    cur = cur[s] as Record<string, unknown>;
  }
  cur[segments[segments.length - 1]] = value;
}

// Delete the leaf and prune empty parent objects so disabled flags don't
// leave dangling `experimental: {}` containers in the config file.
function unsetAt(root: Record<string, unknown>, segments: readonly string[]): void {
  const stack: Record<string, unknown>[] = [root];
  let cur = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const next = cur[segments[i]];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    cur = next as Record<string, unknown>;
    stack.push(cur);
  }
  delete cur[segments[segments.length - 1]];
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const child = stack[i + 1];
    if (Object.keys(child).length === 0) delete stack[i][segments[i]];
    else break;
  }
}

export async function runExperimental(runtime: RuntimeEnv): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    runtime.error(
      danger(
        `Config ${snapshot.exists ? "invalid" : "not found"} at ${shortenHomePath(snapshot.path)}`,
      ),
    );
    if (snapshot.exists) {
      for (const line of formatConfigIssueLines(snapshot.issues, danger("×"), {
        normalizeRoot: true,
      })) {
        runtime.error(`  ${line}`);
      }
    }
    runtime.error(`Run ${theme.accent("openclaw doctor")} to repair, then retry.`);
    runtime.exit(1);
    return;
  }

  const root = snapshot.resolved ?? snapshot.config ?? {};
  const states: FlagState[] = EXPERIMENTAL_FLAGS.map((flag) => {
    const segments = flag.path.split(".");
    return {
      path: flag.path,
      segments,
      label: FIELD_LABELS[flag.path] ?? flag.path,
      summary: flag.summary,
      on: readBool(root, segments),
    };
  });

  const prompter = createClackPrompter();
  await prompter.intro("OpenClaw experimental flags");

  let selected: string[];
  try {
    selected = await prompter.multiselect<string>({
      message: "Toggle experimental features (space to select, enter to confirm)",
      options: states.map((s) => ({ value: s.path, label: s.label, hint: s.summary })),
      initialValues: states.filter((s) => s.on).map((s) => s.path),
    });
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      await prompter.outro(theme.muted("Cancelled — no changes written."));
      return;
    }
    throw err;
  }

  const picked = new Set(selected);
  const deltas = states.flatMap((s) =>
    picked.has(s.path) === s.on ? [] : [{ ...s, next: picked.has(s.path) }],
  );
  if (deltas.length === 0) {
    await prompter.outro(theme.muted("No changes."));
    return;
  }

  const next = structuredClone(root as Record<string, unknown>);
  const unsetPaths: string[][] = [];
  for (const d of deltas) {
    if (d.next) setAt(next, d.segments, true);
    else {
      unsetAt(next, d.segments);
      unsetPaths.push([...d.segments]);
    }
  }
  await replaceConfigFile({
    nextConfig: next as unknown as OpenClawConfig,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
    writeOptions: unsetPaths.length > 0 ? { unsetPaths } : undefined,
  });

  const summary = deltas
    .map((d) => `  ${d.next ? success("enabled") : info("disabled")}  ${theme.muted(d.path)}`)
    .join("\n");
  await prompter.note(summary, "Updated config");
  await prompter.outro(`Restart the gateway to apply. (${shortenHomePath(snapshot.path)})`);
}
