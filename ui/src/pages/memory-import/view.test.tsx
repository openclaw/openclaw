import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { MemoryImport } from "./view.tsx";

type MemoryImportProps = Parameters<typeof MemoryImport>[0];

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
        planFingerprint: "a".repeat(64),
        found: true,
        source: "/tmp/codex",
        target: "/tmp/openclaw-research",
        summary: { ...summary, planned: 2 },
        items: ["MEMORY.md", "memory_summary.md"].map((name) => ({
          id: `memory:codex:${name}`,
          status: "planned" as const,
          source: `/tmp/codex/memories/${name}`,
          target: `/tmp/openclaw-research/memory/imports/codex/${name}`,
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
    backfillPreview: null,
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

function renderView(
  overrides: Partial<MemoryImportProps> = {},
  container = document.createElement("div"),
) {
  mountSolid(() => <MemoryImport {...createProps(overrides)} />, { container });
  flush();
  return container;
}

describe("renderMemoryImport", () => {
  it("renders shared skeletons while the import plan is loading", () => {
    const container = document.createElement("div");
    renderView({ loading: true, plan: null }, container);

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

  it("groups memory by source collection without rendering file contents", () => {
    const plan = createPlan();
    const container = document.createElement("div");
    renderView({ plan }, container);

    expect(container.textContent).toContain("MEMORY.md");
    expect(container.textContent).toContain("memory_summary.md");
    expect(container.textContent).toContain("/tmp/openclaw-research/memory/imports/");
    expect(container.textContent).toContain("Consolidated Codex memory files.");
    expect(container.textContent).not.toContain("Import Codex memory.");
    expect(container.textContent).not.toContain("private memory body");
  });

  it("hides the agent row when only one agent is configured", () => {
    const container = document.createElement("div");
    renderView({}, container);

    expect(container.querySelector('openclaw-agent-select[name="memory-import-agent"]')).toBeNull();
    expect(container.textContent).not.toContain("Destination agent");
  });

  it("renders the avatar agent picker and routes agent changes", async () => {
    const onSelectAgent = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    renderView(
      {
        agents: [
          { id: "research", name: "Research", identity: { emoji: "🔎" } },
          { id: "writer", name: "Writer" },
        ],
        onSelectAgent,
      },
      container,
    );

    const picker = container.querySelector<
      HTMLElement & {
        options: Array<{ value: string }>;
        onSelect: (value: string) => void;
        updateComplete: Promise<boolean>;
      }
    >('openclaw-agent-select[name="memory-import-agent"]');
    await picker?.updateComplete;
    expect(picker?.options.map((option) => option.value)).toEqual(["research", "writer"]);
    expect(picker?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe("🔎");

    picker?.onSelect("writer");
    expect(onSelectAgent).toHaveBeenCalledWith("writer");
    container.remove();
  });

  it("renders per-day session backfill candidates and final staging progress", () => {
    const container = document.createElement("div");
    renderView(
      {
        backfillPreview: {
          days: 1,
          candidates: 2,
          staged: 0,
          truncated: true,
          perDay: [
            {
              day: "2026-07-01",
              candidateCount: 2,
              sample: ["Remember the release checklist", "Use the main agent"],
            },
          ],
        },
        backfillProgress: { days: 3, candidates: 7, staged: 4, complete: true },
      },
      container,
    );

    expect(
      container.querySelector('.memory-import__backfill-preview [role="status"]')?.textContent,
    ).toContain("2 candidates across 1 days");
    expect(container.textContent).toContain("2026-07-01");
    expect(container.textContent).toContain("Remember the release checklist");
    expect(container.textContent).toContain("preview shows the first bounded batch");
    expect(container.textContent).toContain("4 staged; promotion happens via dreaming");
    expect(container.textContent).toContain("3 days processed");
  });

  it("requires destructive confirmation before session backfill rollback", () => {
    const onBackfillRollbackConfirm = vi.fn();
    const container = document.createElement("div");
    renderView({ backfillRollbackPending: true, onBackfillRollbackConfirm }, container);

    expect(container.textContent).toContain("Session backfill cursors are rewound");
    container
      .querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-rollback-confirm']")
      ?.click();
    expect(onBackfillRollbackConfirm).toHaveBeenCalledOnce();
  });

  it("serializes memory imports with backfill mutations", () => {
    const importing = document.createElement("div");
    renderView({ applyingProviderId: "codex" }, importing);
    expect(
      importing.querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-apply']")
        ?.disabled,
    ).toBe(true);

    const backfilling = document.createElement("div");
    renderView({ backfillBusy: "apply" }, backfilling);
    expect(
      backfilling.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
        ?.disabled,
    ).toBe(true);
  });

  it("passes the exact collection item ids when selection changes", () => {
    const onToggleCollection = vi.fn();
    const container = renderView({ onToggleCollection });
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

  it("requires confirmation and explains replacement backups", () => {
    const onConfirmImport = vi.fn();
    const container = renderView({
      pendingProviderId: "codex",
      replaceExisting: true,
      onConfirmImport,
    });

    expect(container.textContent).toContain("backed up in the migration report");
    const confirm = expectDefined(
      container.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']"),
      "import confirmation button",
    );
    confirm.click();
    expect(onConfirmImport).toHaveBeenCalledOnce();
  });

  it("disables confirmation actions while an import is running", () => {
    const onConfirmImport = vi.fn();
    const onCancelImport = vi.fn();
    const container = renderView({
      agents: [
        { id: "research", name: "Research" },
        { id: "writer", name: "Writer" },
      ],
      pendingProviderId: "codex",
      applyingProviderId: "codex",
      onConfirmImport,
      onCancelImport,
    });

    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>(".exec-approval-actions button"),
    ];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
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
              details: {
                recoveryRecordPath: "/tmp/migration-report/recovery-complete.json",
              },
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
    expect(result?.textContent).toContain("/tmp/migration-report/recovery-complete.json");
  });
});
