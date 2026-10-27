import { expectDefined } from "@openclaw/normalization-core";
import { createMemo } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSelectElement } from "../../components/agent-select.tsx";
import { i18n } from "../../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { MemoryImport } from "./view.tsx";

type MemoryImportProps = Omit<Parameters<typeof MemoryImport>[0], "readPlan" | "readScope">;
const research = { id: "research", name: "Research", identity: { emoji: "🔎" } };
const writer = { id: "writer", name: "Writer" };

const summary = {
  total: 2,
  planned: 0,
  migrated: 0,
  skipped: 0,
  conflicts: 0,
  errors: 0,
  sensitive: 0,
};

function createPlan(): NonNullable<MemoryImportProps["plan"]> {
  return {
    agentId: "research",
    workspace: "/tmp/openclaw-research",
    providers: [
      {
        providerId: "codex",
        label: "Codex",
        description: "Import Codex memory.",
        found: true,
        source: "/tmp/codex",
        target: "/tmp/openclaw-research",
        summary: { ...summary, planned: 2 },
        items: ["MEMORY.md", "memory_summary.md"].map((name) => ({
          id: `memory:codex:${name}`,
          status: "planned" as const,
          source: `/tmp/codex/memories/${name}`,
          details: { collectionId: "codex", collectionLabel: "Codex", relativePath: name },
        })),
      },
    ],
  };
}

function createProps(overrides: Partial<MemoryImportProps> = {}): MemoryImportProps {
  return {
    connected: true,
    canAdmin: true,
    agents: [{ id: "research", name: "Research" }],
    selectedAgentId: "research",
    plan: createPlan(),
    loading: false,
    error: null,
    applyError: null,
    replaceExisting: false,
    selectedByProvider: {
      codex: ["memory:codex:MEMORY.md", "memory:codex:memory_summary.md"],
    },
    applyingProviderId: null,
    pendingProviderId: null,
    lastResults: {},
    backfillAvailable: true,
    backfillFrom: "",
    backfillTo: "",
    backfillBusy: null,
    backfillError: null,
    readPreview: () => null,
    backfillProgress: null,
    backfillRollbackResult: null,
    backfillRollbackPending: false,
    onSelectAgent: vi.fn(),
    onReplaceExisting: vi.fn(),
    onRefresh: vi.fn(),
    onToggleCollection: vi.fn(),
    onRequestImport: vi.fn(),
    onConfirmImport: vi.fn(),
    onCancelImport: vi.fn(),
    onBackfillFromChange: vi.fn(),
    onBackfillToChange: vi.fn(),
    onBackfillPreview: vi.fn(),
    onBackfillApply: vi.fn(),
    onBackfillRollbackRequest: vi.fn(),
    onBackfillRollbackConfirm: vi.fn(),
    onBackfillRollbackCancel: vi.fn(),
    ...overrides,
  };
}

function renderView(overrides: Partial<MemoryImportProps> = {}) {
  const { container } = mountSolid(() => {
    const props = createProps(overrides);
    const readPlan = createMemo(() =>
      props.loading && !props.plan ? new Promise<never>(() => {}) : props.plan,
    );
    return <MemoryImport {...props} readPlan={readPlan} readScope={props} />;
  });
  flush();
  return container;
}

function findButton(container: Element, testId: string) {
  return expectDefined(
    container.querySelector<HTMLButtonElement>(`[data-test-id='${testId}']`),
    testId,
  );
}

describe("renderMemoryImport", () => {
  it("renders shared skeletons while the import plan is loading", () => {
    const container = renderView({ loading: true, plan: null });
    const blocks = container.querySelectorAll(".memory-import__skeleton");
    expect(blocks).toHaveLength(2);
    expect([...blocks].every((block) => block.classList.contains("skeleton"))).toBe(true);
  });

  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(() => {
    cleanupSolid();
    vi.unstubAllGlobals();
  });

  it("groups memory files and toggles the exact collection without an unnecessary agent picker", () => {
    const onToggleCollection = vi.fn();
    const container = renderView({ onToggleCollection });
    expect(container.textContent).toContain("MEMORY.md");
    expect(container.textContent).toContain("memory_summary.md");
    expect(container.textContent).toContain("/tmp/openclaw-research/memory/imports/");
    expect(container.textContent).toContain("Consolidated Codex memory files.");
    expect(container.textContent).not.toContain("Import Codex memory.");
    expect(container.querySelector('openclaw-agent-select[name="memory-import-agent"]')).toBeNull();
    expect(container.textContent).not.toContain("Destination agent");
    const checkbox = expectDefined(
      container.querySelector<HTMLInputElement>(".memory-import__collection-choice input"),
      "collection checkbox",
    );
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onToggleCollection).toHaveBeenCalledWith(
      "codex",
      ["memory:codex:MEMORY.md", "memory:codex:memory_summary.md"],
      false,
    );
  });

  it("renders the avatar agent picker and routes agent changes", async () => {
    const onSelectAgent = vi.fn();
    const container = renderView({
      agents: [research, writer],
      onSelectAgent,
    });

    const picker = container.querySelector<AgentSelectElement>(
      'openclaw-agent-select[name="memory-import-agent"]',
    );
    await picker?.updateComplete;
    expect(picker?.options.map((option) => option.value)).toEqual(["research", "writer"]);
    expect(picker?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe("🔎");

    picker?.onSelect("writer");
    expect(onSelectAgent).toHaveBeenCalledWith("writer");
  });

  it("explains the cursor reset before confirming session backfill rollback", () => {
    const onBackfillRollbackConfirm = vi.fn();
    const container = renderView({ backfillRollbackPending: true, onBackfillRollbackConfirm });
    expect(container.textContent).toContain("Session backfill cursors are rewound");
    expect(findButton(container, "memory-backfill-rollback-confirm").disabled).toBe(false);
    findButton(container, "memory-backfill-rollback-confirm").click();
    expect(onBackfillRollbackConfirm).toHaveBeenCalledOnce();
  });

  it("serializes memory imports with backfill mutations", () => {
    const importing = renderView({ applyingProviderId: "codex" });
    expect(findButton(importing, "memory-backfill-apply").disabled).toBe(true);
    const backfilling = renderView({ backfillBusy: "apply" });
    expect(findButton(backfilling, "memory-import-provider-button").disabled).toBe(true);
  });

  it("requires confirmation and explains replacement backups", () => {
    const onConfirmImport = vi.fn();
    const container = renderView({
      pendingProviderId: "codex",
      replaceExisting: true,
      onConfirmImport,
    });
    expect(container.textContent).toContain("backed up in the migration report");
    expect(findButton(container, "memory-import-confirm").disabled).toBe(false);
    findButton(container, "memory-import-confirm").click();
    expect(onConfirmImport).toHaveBeenCalledOnce();
  });

  it("disables confirmation actions while an import is running", () => {
    const onConfirmImport = vi.fn();
    const onCancelImport = vi.fn();
    const container = renderView({
      agents: [research, writer],
      pendingProviderId: "codex",
      applyingProviderId: "codex",
      onConfirmImport,
      onCancelImport,
    });

    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>(".exec-approval-actions button"),
    ];
    expect(buttons).toMatchObject([{ disabled: true }, { disabled: true }]);
    buttons[0]?.click();
    expect(onConfirmImport).not.toHaveBeenCalled();
    container
      .querySelector("openclaw-modal-dialog")
      ?.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true }));
    expect(onCancelImport).not.toHaveBeenCalled();

    const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Refresh",
    );
    expect(refresh?.disabled).toBe(true);
    for (const selector of [
      'openclaw-agent-select[name="memory-import-agent"]',
      "[data-test-id='memory-import-provider-button']",
      ".memory-import__collection-choice input",
    ]) {
      expect(container.querySelector(selector)).toMatchObject({ disabled: true });
    }
  });

  it("shows partial import failures with the saved report", () => {
    const plan = createPlan();
    Object.assign(plan.providers[0]!, { found: false, error: "provider rescan failed" });
    const container = renderView({
      plan,
      lastResults: {
        codex: {
          providerId: "codex",
          source: "/tmp/codex",
          summary: { ...summary, migrated: 1, errors: 1 },
          items: [
            {
              id: "memory:codex:MEMORY.md",
              status: "error",
              target: "/tmp/workspace/memory/imports/codex/MEMORY.md",
              reason: "replacement interrupted",
              details: {
                recoveryPath: "/tmp/workspace/.openclaw-memory-import-staging/MEMORY.md",
                recoveryRecordPath: "/tmp/migration-report/recovery-required.json",
                backupPath: "/tmp/migration-report/item-backups/MEMORY.md",
              },
            },
            {
              id: "memory:codex:memory_summary.md",
              status: "migrated",
              target: "/tmp/workspace/memory/imports/codex/memory_summary.md",
              details: { recoveryRecordPath: "/tmp/recovery-complete.json" },
            },
          ],
          reportDir: "/tmp/migration-report",
        },
      },
    });

    const result = container.querySelector(".memory-import__result--incomplete");
    expect(result?.getAttribute("role")).toBe("alert");
    expect(container.textContent).toContain("provider rescan failed");
    expect(result?.textContent).toContain("Import incomplete");
    expect(result?.textContent).toContain("1 imported · 1 failed · 0 conflicts");
    expect(result?.textContent).toContain("report saved");
    expect(result?.textContent).toContain("/tmp/migration-report");
    expect(result?.textContent).toContain("replacement interrupted");
    expect(result?.textContent).toContain(
      "/tmp/workspace/.openclaw-memory-import-staging/MEMORY.md",
    );
    expect(result?.textContent).toContain("Recovery file");
    expect(result?.textContent).toContain("Recovery journal");
    expect(result?.textContent).toContain("Item backup");
    expect(result?.textContent).toContain("/tmp/migration-report/recovery-required.json");
    expect(result?.textContent).toContain("/tmp/migration-report/item-backups/MEMORY.md");
    expect(result?.textContent).toContain("/tmp/recovery-complete.json");
  });
});
