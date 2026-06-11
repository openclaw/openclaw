import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import {
  createBookWriterPlan,
  createBookWriterFullDraft,
  draftBookWriterPlan,
  requestBookWriterAiHelp,
  requestBookWriterSetupAiHelp,
  loadBookWriterDashboard,
  stitchBookWriterPlan,
  type BookWriterDashboardSnapshot,
  type BookWriterDashboardState,
  type BookWriterPlan,
} from "./book-writer-dashboard.ts";

function plan(params?: Partial<BookWriterPlan>): BookWriterPlan {
  return {
    schemaVersion: 1,
    kind: "full",
    runId: "book-run",
    title: "Bridge Ledger",
    subtitle: "An Original Book",
    slug: "bridge-ledger",
    topic: "A clean bridge mystery.",
    genre: "clean commercial mystery",
    penName: "Northstar House",
    targetWords: 1600,
    createdAt: "2026-05-25T00:00:00Z",
    updatedAt: "2026-05-25T00:00:00Z",
    version: 1,
    status: "paragraph-plan",
    mode: "advanced",
    brief: {
      topicParagraph: "A clean bridge mystery.",
      readerPromise: "A fair mystery with practical courage.",
      audience: "Commercial readers.",
      tone: "Clean and concrete.",
      constraints: ["Original only."],
    },
    styleGuide: {
      tonePreset: "professional",
      toneDescription: "Professional: Polished, practical, and clear.",
      profanityLevel: "none",
      profanityDescription: "Clean language for the category.",
    },
    chapters: [
      {
        id: "chapter-1",
        number: 1,
        title: "The First Ledger",
        description: "Open the case.",
        styleDirection: "",
        targetWords: 800,
        locked: false,
        status: "planned",
        paragraphs: [
          {
            id: "paragraph-1",
            order: 1,
            title: "Hook",
            summary: "This paragraph says the suspicious invoice appears.",
            purpose: "Open with the suspicious invoice.",
            beats: ["Invoice appears."],
            styleDirection: "",
            targetWords: 200,
            text: "",
            locked: false,
            status: "planned",
          },
        ],
      },
    ],
    cover: {
      brief: "Clean mystery cover.",
      prompt: "Clean mystery cover.",
      status: "planned",
      variants: [],
    },
    publishing: {
      channel: "kdp",
      finalSubmitRequiresApproval: true,
      status: "not-ready",
      checklist: ["Review"],
    },
    artifactLinks: {},
    revisionHistory: [],
    ...params,
  };
}

function snapshot(
  currentPlan: BookWriterPlan,
  manuscriptPreview = "",
): BookWriterDashboardSnapshot {
  return {
    generatedAt: "2026-05-25T00:00:00Z",
    outputDir: "/tmp/books",
    selectedRunId: currentPlan.runId,
    plan: currentPlan,
    manuscriptPreview,
    projects: [
      {
        runId: currentPlan.runId,
        title: currentPlan.title,
        subtitle: currentPlan.subtitle,
        penName: currentPlan.penName,
        genre: currentPlan.genre,
        status: currentPlan.status,
        kind: currentPlan.kind,
        version: currentPlan.version,
        updatedAt: currentPlan.updatedAt,
        targetWords: currentPlan.targetWords,
        draftedWords: currentPlan.chapters[0].paragraphs[0].text ? 4 : 0,
        chapterCount: 1,
        paragraphCount: 1,
        lockedParagraphCount: 0,
        artifactLinks: {},
      },
    ],
    archivedBooks: [],
    deletedBooks: [],
    finishedBooks: [],
    penNameProfiles: [],
    planQuality: {
      status: "pass",
      findings: [],
      counts: {
        chapters: 1,
        paragraphs: 1,
        draftedParagraphs: currentPlan.chapters[0].paragraphs[0].text ? 1 : 0,
        lockedParagraphs: 0,
        draftedWords: currentPlan.chapters[0].paragraphs[0].text ? 4 : 0,
      },
    },
    reviewPack: null,
    publishDryRun: null,
    automation: {
      enabled: false,
      scheduled: false,
      status: "manual-only",
      message: "Manual only.",
    },
    generationModel: {
      provider: "ollama",
      model: "qwen2.5:32b",
    },
    localAiHealth: {
      status: "ready",
      provider: "ollama",
      model: "qwen2.5:32b",
      baseUrl: "http://127.0.0.1:11434",
      reachable: true,
      modelAvailable: true,
      modelLoaded: true,
      message: "Local AI is connected and the selected model is warm.",
      lastCheckedAt: "2026-05-25T00:00:00Z",
      benchmark: {
        source: "measured",
        tokensPerSecond: 24.7,
        peakMemoryGb: 21.5,
        qualityScore: 0.82,
        measuredAt: "2026-05-25T00:00:00Z",
      },
      guidance: ["You can use Book Studio AI buttons now."],
    },
    nextActions: [],
  };
}

function state(
  client: Pick<GatewayBrowserClient, "request">,
  snapshotValue: BookWriterDashboardSnapshot | null = null,
) {
  const updates: Array<string | null> = [];
  const dashboardState: BookWriterDashboardState = {
    client: client as GatewayBrowserClient,
    connected: true,
    bookWriterLoading: false,
    bookWriterError: null,
    bookWriterDashboard: snapshotValue,
    bookWriterLastFetchAt: null,
    bookWriterSelectedRunId: snapshotValue?.selectedRunId ?? null,
    bookWriterTopicDraft: "A clean bridge mystery.",
    bookWriterTargetWordsDraft: 1600,
    bookWriterToneDraft: "professional",
    bookWriterCustomToneDraft: "",
    bookWriterProfanityDraft: "none",
    bookWriterPenNameDraft: "",
    bookWriterNewBookSetupOpen: true,
    bookWriterReadPage: 0,
    bookWriterActiveView: "brief",
    bookWriterMode: "guided",
    bookWriterPendingAiAction: null,
    bookWriterPendingAiSuggestion: null,
    bookWriterPendingDestructiveAction: null,
    bookWriterActionReceipt: null,
    bookWriterCelebration: null,
    bookWriterFocusedParagraphId: null,
    bookWriterSearchQuery: "",
    bookWriterSavingAction: null,
    bookWriterUndoStack: [],
    bookWriterRedoStack: [],
    requestUpdate: () => updates.push(dashboardState.bookWriterSavingAction),
  };
  return { dashboardState, updates };
}

describe("book writer dashboard controller", () => {
  it("moves the slow path to the exact next screen after each AI button finishes", async () => {
    const emptyPlan = plan();
    const draftedPlan = plan({
      version: 2,
      status: "drafting",
      chapters: [
        {
          ...emptyPlan.chapters[0],
          paragraphs: [
            {
              ...emptyPlan.chapters[0].paragraphs[0],
              text: "Audrey found the invoice at sunrise.",
              status: "drafted",
            },
          ],
        },
      ],
    });
    const stitchedPlan = plan({ ...draftedPlan, version: 3, status: "stitched" });
    const request = vi.fn(async (method: string) => {
      if (method === "bookWriter.plan.create") {
        return snapshot(emptyPlan);
      }
      if (method === "bookWriter.plan.draft") {
        return snapshot(draftedPlan);
      }
      if (method === "bookWriter.plan.stitch") {
        return snapshot(stitchedPlan, "# Bridge Ledger\n\nAudrey found the invoice at sunrise.\n");
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { dashboardState } = state({ request } as Pick<GatewayBrowserClient, "request">);

    await createBookWriterPlan(dashboardState);
    expect(dashboardState.bookWriterActiveView).toBe("chapters");

    await draftBookWriterPlan(dashboardState);
    expect(dashboardState.bookWriterActiveView).toBe("draft");
    expect(dashboardState.bookWriterFocusedParagraphId).toBe("paragraph-1");

    await stitchBookWriterPlan(dashboardState);
    expect(dashboardState.bookWriterActiveView).toBe("package");
  });

  it("builds a new editable draft in visible, resumable stages", async () => {
    const emptyPlan = plan();
    const draftedPlan = plan({
      version: 2,
      status: "drafting",
      chapters: [
        {
          ...emptyPlan.chapters[0],
          paragraphs: [
            {
              ...emptyPlan.chapters[0].paragraphs[0],
              text: "Audrey found the invoice at sunrise.",
              status: "drafted",
            },
          ],
        },
      ],
    });
    const stitchedPlan = plan({ ...draftedPlan, version: 3, status: "stitched" });
    const request = vi.fn(async (method: string) => {
      if (method === "bookWriter.plan.create") {
        return snapshot(emptyPlan);
      }
      if (method === "bookWriter.plan.draft") {
        return snapshot(draftedPlan);
      }
      if (method === "bookWriter.plan.stitch") {
        return snapshot(stitchedPlan, "# Bridge Ledger\n\nAudrey found the invoice at sunrise.\n");
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { dashboardState, updates } = state({ request } as Pick<GatewayBrowserClient, "request">);

    await createBookWriterFullDraft(dashboardState);

    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "bookWriter.plan.create",
      "bookWriter.plan.draft",
      "bookWriter.plan.stitch",
    ]);
    expect(updates).toContain("full-draft-chapters");
    expect(updates).toContain("full-draft-paragraphs");
    expect(updates).toContain("full-draft-text");
    expect(updates).toContain("full-draft-preview");
    expect(dashboardState.bookWriterSavingAction).toBeNull();
    expect(dashboardState.bookWriterActiveView).toBe("draft");
    expect(dashboardState.bookWriterFocusedParagraphId).toBe("paragraph-1");
    expect(dashboardState.bookWriterActionReceipt?.title).toBe(
      "Done. AI built your editable draft.",
    );
  });

  it("resumes a drafted book by building only the missing readable preview", async () => {
    const draftedPlan = plan({
      version: 4,
      status: "drafting",
      chapters: [
        {
          ...plan().chapters[0],
          paragraphs: [
            {
              ...plan().chapters[0].paragraphs[0],
              text: "Audrey found the invoice at sunrise.",
              status: "drafted",
            },
          ],
        },
      ],
    });
    const stitchedPlan = plan({ ...draftedPlan, version: 5, status: "stitched" });
    const request = vi.fn(async (method: string) => {
      if (method === "bookWriter.plan.stitch") {
        return snapshot(stitchedPlan, "# Bridge Ledger\n\nAudrey found the invoice at sunrise.\n");
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { dashboardState, updates } = state(
      { request } as Pick<GatewayBrowserClient, "request">,
      snapshot(draftedPlan),
    );

    await createBookWriterFullDraft(dashboardState);

    expect(request.mock.calls.map((call) => call[0])).toEqual(["bookWriter.plan.stitch"]);
    expect(updates).toContain("full-draft-paragraphs");
    expect(updates).toContain("full-draft-preview");
    expect(dashboardState.bookWriterError).toBeNull();
    expect(dashboardState.bookWriterDashboard?.plan?.status).toBe("stitched");
  });

  it("can explicitly clear the selected book and load the home snapshot", async () => {
    const currentPlan = plan();
    const home = {
      ...snapshot(currentPlan),
      selectedRunId: null,
      plan: null,
      manuscriptPreview: "",
      planQuality: null,
    };
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      expect(method).toBe("bookWriter.dashboard.snapshot");
      expect(params).toEqual({});
      return home;
    });
    const { dashboardState } = state(
      { request } as Pick<GatewayBrowserClient, "request">,
      snapshot(currentPlan),
    );

    await loadBookWriterDashboard(dashboardState, { runId: null });

    expect(dashboardState.bookWriterSelectedRunId).toBeNull();
    expect(dashboardState.bookWriterDashboard?.plan).toBeNull();
  });

  it("uses AI to update the initial setup textbox without creating a book", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "bookWriter.plan.suggestSetupField") {
        expect(params).toEqual(
          expect.objectContaining({
            topic: "A clean bridge mystery.",
            targetWords: 1600,
            tonePreset: "professional",
            profanityLevel: "none",
            intent: "improve",
          }),
        );
        return {
          runId: "new-book-draft",
          target: "topic",
          intent: "improve",
          original: "A clean bridge mystery.",
          suggestion:
            "A clean commercial mystery about a small-town bridge inspector who uncovers invoice fraud before a public dedication ceremony.",
          explanation: "Setup suggestion.",
          contextSummary: "Current setup controls.",
          engine: "local-context-fallback",
          lockedContext: [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { dashboardState } = state({ request } as Pick<GatewayBrowserClient, "request">, null);

    await requestBookWriterSetupAiHelp(dashboardState, "improve");

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("bookWriter.plan.suggestSetupField");
    expect(dashboardState.bookWriterTopicDraft).toContain("bridge inspector");
    expect(dashboardState.bookWriterActionReceipt?.title).toBe("AI updated the book description");
  });

  it("applies AI field help directly to the editable plan", async () => {
    const currentPlan = plan();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "bookWriter.plan.suggestField") {
        return {
          runId: currentPlan.runId,
          target: "chapterTitle",
          intent: "improve",
          chapterId: "chapter-1",
          original: "The First Ledger",
          suggestion: "The Invoice at Sunrise",
          explanation: "Context-aware suggestion.",
          contextSummary: "Full book context.",
          engine: "local-context-fallback",
        };
      }
      if (method === "bookWriter.plan.save") {
        const { plan: savedPlan } = params as { plan: BookWriterPlan };
        return snapshot({ ...savedPlan, version: 2 });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { dashboardState } = state(
      { request } as Pick<GatewayBrowserClient, "request">,
      snapshot(currentPlan),
    );

    await requestBookWriterAiHelp(dashboardState, {
      target: "chapterTitle",
      intent: "improve",
      chapterId: "chapter-1",
    });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "bookWriter.plan.suggestField",
      expect.objectContaining({ target: "chapterTitle" }),
      expect.anything(),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "bookWriter.plan.save",
      expect.objectContaining({
        plan: expect.objectContaining({
          chapters: [expect.objectContaining({ title: "The Invoice at Sunrise" })],
        }),
      }),
      expect.anything(),
    );
    expect(dashboardState.bookWriterDashboard?.plan?.chapters[0].title).toBe(
      "The Invoice at Sunrise",
    );
    expect(dashboardState.bookWriterActionReceipt?.title).toBe("AI updated the field");
  });
});
