import type { GatewayBrowserClient } from "../gateway.ts";

export type BookWriterPlanStatus =
  | "brief"
  | "chapter-plan"
  | "paragraph-plan"
  | "drafting"
  | "stitched"
  | "packaged"
  | "publish-ready";
export type BookWriterPlanMode = "simple" | "advanced";
export type BookWriterDashboardView =
  | "brief"
  | "chapters"
  | "paragraphs"
  | "draft"
  | "package"
  | "publish";
export type BookWriterDashboardMode = "guided" | "advanced";
export type BookWriterTonePreset =
  | "professional"
  | "technical"
  | "conversational"
  | "humorous"
  | "dramatic"
  | "literary"
  | "inspirational"
  | "direct"
  | "custom";
export type BookWriterProfanityLevel = "none" | "mild" | "moderate" | "high" | "extreme";
export type BookWriterAiAction =
  | "create"
  | "full-draft"
  | "paragraph-plan"
  | "draft"
  | "propagate"
  | "rebalance"
  | "stitch"
  | "package"
  | "fix"
  | "publish"
  | "cover-local-ai"
  | "cover-concept"
  | "cover-generate";
export type BookWriterIdeaSetupTarget =
  | "title"
  | "summary"
  | "readerPromise"
  | "targetWords"
  | "tone"
  | "audience";
export type BookWriterChapterSetupTarget = "title" | "description" | "style" | "role";
export type BookWriterAiHelpIntent =
  | "fill"
  | "improve"
  | "shorten"
  | "clearer"
  | "dramatic"
  | "humorous"
  | "custom";
export type BookWriterAiHelpTarget =
  | "bookStyle"
  | "title"
  | "topic"
  | "audience"
  | "readerPromise"
  | "chapterTitle"
  | "chapterDescription"
  | "chapterStyle"
  | "paragraphTitle"
  | "paragraphSummary"
  | "paragraphPlan"
  | "paragraphStyle"
  | "paragraphText"
  | "coverBrief"
  | "coverPrompt";
export type BookWriterAiHelpRequest = {
  target: BookWriterAiHelpTarget;
  intent: BookWriterAiHelpIntent;
  chapterId?: string;
  paragraphId?: string;
  customDirection?: string;
};
export type BookWriterAiHelpSuggestion = {
  runId: string;
  target: BookWriterAiHelpTarget;
  intent: BookWriterAiHelpIntent;
  chapterId?: string;
  paragraphId?: string;
  original: string;
  suggestion: string;
  explanation: string;
  contextSummary: string;
  engine?: "live-model" | "local-context-fallback";
  lockedContext?: string[];
};
export type BookWriterActionReceipt = {
  title: string;
  detail: string;
  next: string;
};
export type BookWriterCelebration = {
  id: string;
  title: string;
  kind: "created" | "finished";
  at: number;
};
export type BookWriterDestructiveAction =
  | { kind: "move-active"; runId: string; title: string }
  | { kind: "move-active-many"; runIds: string[]; count: number }
  | { kind: "delete-archived"; archivedId: string; title: string }
  | { kind: "delete-deleted"; deletedId: string; title: string }
  | { kind: "empty-deleted"; count: number };

export type BookWriterParagraphStatus = "planned" | "drafted" | "needs-revision" | "approved";

export type BookWriterParagraph = {
  id: string;
  order: number;
  title: string;
  summary: string;
  purpose: string;
  beats: string[];
  styleDirection: string;
  fieldLocks?: {
    title?: boolean;
    summary?: boolean;
    purpose?: boolean;
    styleDirection?: boolean;
    text?: boolean;
  };
  targetWords: number;
  text: string;
  locked: boolean;
  status: BookWriterParagraphStatus;
  sourceParagraphIds?: string[];
};

export type BookWriterChapterRole = {
  storyThread:
    | "main-story"
    | "side-story"
    | "converging-stories"
    | "flashback"
    | "interlude"
    | "abrupt-shift"
    | "resolution"
    | "custom";
  plotJob:
    | "setup"
    | "conflict"
    | "clue"
    | "red-herring"
    | "twist"
    | "reveal"
    | "payoff"
    | "mystery-deepens"
    | "custom";
  readerFeeling:
    | "calm"
    | "funny"
    | "suspenseful"
    | "dramatic"
    | "warm"
    | "dark"
    | "hopeful"
    | "fast-paced"
    | "custom";
  notes: string;
};

export type BookWriterChapter = {
  id: string;
  number: number;
  title: string;
  description: string;
  styleDirection: string;
  role?: BookWriterChapterRole;
  fieldLocks?: {
    title?: boolean;
    description?: boolean;
    styleDirection?: boolean;
    roleNotes?: boolean;
  };
  targetWords: number;
  locked: boolean;
  status: BookWriterParagraphStatus;
  paragraphs: BookWriterParagraph[];
};

export type BookWriterPlan = {
  schemaVersion: 1;
  kind: "full" | "quick-read";
  sourceRunId?: string;
  runId: string;
  title: string;
  subtitle: string;
  slug: string;
  topic: string;
  genre: string;
  penName: string;
  targetWords: number;
  createdAt: string;
  updatedAt: string;
  version: number;
  status: BookWriterPlanStatus;
  mode: BookWriterPlanMode;
  canonVersion?: number;
  cohesionStatus?: "unbuilt" | "planned" | "drafted" | "revised" | "audited";
  qualityScore?: number;
  lastCohesionRunId?: string;
  storylineOverview?: {
    status: "current" | "stale" | "needs-refresh";
    shortText: string;
    protagonistGoal: string;
    centralConflict: string;
    currentTwist?: string;
    stakes: string;
    relationshipDynamics: string[];
    unresolvedQuestions: string[];
    nextChapterDirection: string;
    sourceVersion: number;
    updatedAt: string;
    confidence: number;
  };
  bookSync?: {
    state:
      | "synced"
      | "story-impact-detected"
      | "needs-propagation"
      | "updating-affected-chapters"
      | "locked-conflict-found"
      | "cohesion-review-needed"
      | "fully-updated";
    pendingImpactId?: string;
    lastAnalyzedVersion?: number;
    lastSyncedVersion?: number;
    affectedChapterIds: string[];
    affectedParagraphIds: string[];
    lockedConflictCount: number;
    cohesionScore?: number;
    summary: string;
  };
  brief: {
    topicParagraph: string;
    readerPromise: string;
    audience: string;
    tone: string;
    constraints: string[];
  };
  styleGuide?: {
    tonePreset: BookWriterTonePreset;
    toneDescription: string;
    profanityLevel: BookWriterProfanityLevel;
    profanityDescription: string;
  };
  chapters: BookWriterChapter[];
  cover: {
    brief: string;
    prompt: string;
    status: "planned" | "generated" | "approved";
    variants: Array<{
      id: string;
      label: string;
      path?: string;
      source?: "local-ai" | "svg-concept" | "upload" | "kdp-cover-creator";
      prompt?: string;
      provider?: string;
      model?: string;
      createdAt?: string;
      mimeType?: string;
      previewDataUrl?: string;
      approved: boolean;
    }>;
  };
  publishing: {
    channel: "kdp";
    finalSubmitRequiresApproval: true;
    status: "not-ready" | "dry-run-ready" | "approval-required";
    checklist: string[];
  };
  artifactLinks: Record<string, string>;
  revisionHistory: Array<{ version: number; at: string; action: string; summary: string }>;
};

export type BookWriterProjectSummary = {
  runId: string;
  title: string;
  subtitle: string;
  penName: string;
  genre: string;
  status: BookWriterPlanStatus;
  kind: BookWriterPlan["kind"];
  version: number;
  updatedAt: string;
  targetWords: number;
  draftedWords: number;
  chapterCount: number;
  paragraphCount: number;
  lockedParagraphCount: number;
  artifactLinks: Record<string, string>;
};

export type DeletedBookWriterProjectSummary = {
  deletedId: string;
  runId: string;
  title: string;
  subtitle: string;
  penName: string;
  genre: string;
  status: BookWriterPlanStatus;
  kind: BookWriterPlan["kind"];
  version: number;
  deletedAt: string;
  originalDir?: string;
  targetWords: number;
  draftedWords: number;
  chapterCount: number;
  paragraphCount: number;
};

export type ArchivedBookWriterProjectSummary = {
  archivedId: string;
  runId: string;
  title: string;
  subtitle: string;
  penName: string;
  genre: string;
  status: BookWriterPlanStatus;
  kind: BookWriterPlan["kind"];
  version: number;
  archivedAt: string;
  originalDir?: string;
  targetWords: number;
  draftedWords: number;
  chapterCount: number;
  paragraphCount: number;
};

export type FinishedBookWriterProjectSummary = {
  finishedId: string;
  runId: string;
  title: string;
  subtitle: string;
  penName: string;
  genre: string;
  status: BookWriterPlanStatus;
  kind: BookWriterPlan["kind"];
  version: number;
  finishedAt: string;
  publishedAt?: string;
  originalDir?: string;
  coverPath?: string;
  coverSource?: string;
  coverPreviewDataUrl?: string;
  publishProof?: BookWriterPublishedProof;
  metrics?: BookWriterPublishedMetrics;
  targetWords: number;
  draftedWords: number;
  chapterCount: number;
  paragraphCount: number;
  artifactLinks: Record<string, string>;
};

export type BookWriterPublishedProof = {
  destination: "amazon-kdp" | "kindle" | "paperback" | "other";
  publishedAt: string;
  operatorConfirmed?: boolean;
  confirmedAt?: string;
  asin?: string;
  marketplaceUrl?: string;
  priceUsd?: number;
  category?: string;
  keywords?: string[];
};

export type BookWriterPublishedSalesSnapshot = {
  id: string;
  label: string;
  rangeStart?: string;
  rangeEnd?: string;
  unitsSold: number;
  revenueUsd: number;
  adSpendUsd: number;
  profitUsd: number;
  kuPagesRead?: number;
  royaltyUsd?: number;
  notes?: string;
};

export type BookWriterPublishedMetrics = {
  totalSales: number;
  totalRevenueUsd: number;
  totalProfitUsd: number;
  adSpendUsd: number;
  ratingAverage?: number;
  reviewCount?: number;
  snapshots: BookWriterPublishedSalesSnapshot[];
  updatedAt?: string;
};

export type BookWriterNextBookRecommendation = {
  topicParagraph: string;
  title: string;
  confidence: "starter" | "medium" | "high";
  why: string;
  evidence: string[];
};

export type BookWriterPenNameProfile = {
  name: string;
  lane: string;
  readerPromise: string;
  publishedCount: number;
  completedCount: number;
  inProgressCount: number;
  books: {
    published: Array<{ id: string; title: string; genre: string; words: number }>;
    completed: Array<{ id: string; title: string; genre: string; words: number }>;
    inProgress: Array<{ id: string; title: string; genre: string; words: number }>;
  };
  updatedAt?: string;
};

export type BookWriterAutomationStatus = {
  enabled: boolean;
  scheduled: boolean;
  status: "manual-only" | "scheduled" | "scheduled-paused";
  message: string;
  schedulePath?: string;
  scriptPath?: string;
  cronExpression?: string;
  timezone?: string;
};

export type BookWriterGenerationModel = {
  provider: "lmstudio" | "ollama" | "custom";
  model: string;
};

export type BookWriterLocalAiHealth = {
  status: "ready" | "unreachable" | "model-missing" | "unknown";
  provider: "lmstudio" | "ollama" | "custom";
  model: string;
  baseUrl: string;
  reachable: boolean;
  modelAvailable: boolean;
  modelLoaded: boolean;
  message: string;
  lastCheckedAt: string;
  lastError?: string;
  benchmark?: {
    source: "estimated" | "measured" | "unavailable";
    tokensPerSecond: number;
    peakMemoryGb: number;
    qualityScore: number;
    measuredAt: string;
  };
  guidance: string[];
};

export type BookWriterGateFinding = {
  code: string;
  status: "pass" | "fail" | "warn" | "blocked";
  message: string;
  score?: number;
};

export type BookWriterPlanQuality = {
  status: "pass" | "fail" | "warn" | "blocked";
  findings: BookWriterGateFinding[];
  counts: {
    chapters: number;
    paragraphs: number;
    draftedParagraphs: number;
    lockedParagraphs: number;
    draftedWords: number;
  };
};

export type BookWriterReviewPack = {
  runId: string;
  recommendation: "approve" | "revise" | "reject" | "blocked";
  artifacts: Record<string, string>;
  gaps: string[];
  publishPreview: {
    title: string;
    subtitle: string;
    description: string;
    keywords: string[];
    categories: string[];
    aiDisclosure: string;
    kdpSelectDefault: boolean;
    pricing: { ebookUsd: number; paperbackUsd?: number };
    checklist: string[];
  };
};

export type BookWriterPublishDryRun = {
  runId: string;
  status: "ready" | "needs-review" | "blocked";
  coverStrategy: "kdp-cover-creator" | "upload";
  findings: BookWriterGateFinding[];
  uploadManifest: {
    files: {
      ebook?: string;
      printPdf?: string;
      coverUpload?: string;
      coverBrief?: string;
      metadata?: string;
      publishPreview?: string;
    };
  };
  browserActions: Array<{
    id: string;
    kind: string;
    target: string;
    value?: string | number | boolean | string[];
    file?: string;
    note?: string;
    requiresApproval?: boolean;
  }>;
  finalSubmit: {
    allowed: false;
    requiresApproval: true;
    reason: string;
  };
};

export type BookWriterDashboardSnapshot = {
  generatedAt: string;
  outputDir: string;
  projects: BookWriterProjectSummary[];
  archivedBooks: ArchivedBookWriterProjectSummary[];
  deletedBooks: DeletedBookWriterProjectSummary[];
  finishedBooks: FinishedBookWriterProjectSummary[];
  penNameProfiles: BookWriterPenNameProfile[];
  recommendation?: BookWriterNextBookRecommendation | null;
  selectedRunId: string | null;
  plan: BookWriterPlan | null;
  manuscriptPreview: string;
  planQuality: BookWriterPlanQuality | null;
  reviewPack: BookWriterReviewPack | null;
  publishDryRun: BookWriterPublishDryRun | null;
  automation: BookWriterAutomationStatus;
  generationModel: BookWriterGenerationModel;
  localAiHealth: BookWriterLocalAiHealth;
  localCoverAiStatus?: {
    status: "ready" | "setup-needed" | "fallback";
    provider?: string;
    model?: string;
    message: string;
    guidance: string[];
    checkedAt: string;
  };
  nextActions: string[];
};

export type BookWriterDashboardState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  bookWriterLoading: boolean;
  bookWriterError: string | null;
  bookWriterDashboard: BookWriterDashboardSnapshot | null;
  bookWriterLastFetchAt: number | null;
  bookWriterSelectedRunId: string | null;
  bookWriterTopicDraft: string;
  bookWriterTargetWordsDraft: number;
  bookWriterToneDraft: BookWriterTonePreset;
  bookWriterCustomToneDraft: string;
  bookWriterProfanityDraft: BookWriterProfanityLevel;
  bookWriterPenNameDraft: string;
  bookWriterReadPage: number;
  bookWriterNewBookSetupOpen: boolean;
  bookWriterActiveView: BookWriterDashboardView;
  bookWriterMode: BookWriterDashboardMode;
  bookWriterPendingAiAction: BookWriterAiAction | null;
  bookWriterPendingAiSuggestion: BookWriterAiHelpSuggestion | null;
  bookWriterPendingDestructiveAction: BookWriterDestructiveAction | null;
  bookWriterActionReceipt: BookWriterActionReceipt | null;
  bookWriterCelebration: BookWriterCelebration | null;
  bookWriterFocusedParagraphId: string | null;
  bookWriterSearchQuery: string;
  bookWriterSavingAction: string | null;
  bookWriterUndoStack: BookWriterPlan[];
  bookWriterRedoStack: BookWriterPlan[];
  requestUpdate?: () => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function planCounts(plan: BookWriterPlan | null | undefined) {
  const paragraphs = plan?.chapters.flatMap((chapter) => chapter.paragraphs) ?? [];
  return {
    chapters: plan?.chapters.length ?? 0,
    paragraphs: paragraphs.length,
    written: paragraphs.filter((paragraph) => paragraph.text.trim()).length,
    locked: paragraphs.filter((paragraph) => paragraph.locked).length,
  };
}

function hasReadablePreview(snapshot: BookWriterDashboardSnapshot | null | undefined): boolean {
  const plan = snapshot?.plan;
  return Boolean(
    plan &&
    ["stitched", "packaged", "publish-ready"].includes(plan.status) &&
    snapshot.manuscriptPreview?.trim(),
  );
}

function needsBookText(plan: BookWriterPlan | null | undefined): boolean {
  const counts = planCounts(plan);
  const paragraphs = plan?.chapters.flatMap((chapter) => chapter.paragraphs) ?? [];
  const hasInstructionalText = paragraphs.some((paragraph) =>
    /\b(ai will|plan for ai|chapter focus|this paragraph should|this section should|will describe|will explain|will show)\b/i.test(
      paragraph.text,
    ),
  );
  return counts.paragraphs > 0 && (counts.written < counts.paragraphs || hasInstructionalText);
}

function inferBookWriterTonePreset(plan: BookWriterPlan): BookWriterTonePreset {
  if (plan.styleGuide?.tonePreset) {
    return plan.styleGuide.tonePreset;
  }
  const tone = `${plan.styleGuide?.toneDescription ?? ""} ${plan.brief.tone ?? ""}`.toLowerCase();
  if (/tense|cinematic|dramatic|emotional/.test(tone)) {
    return "dramatic";
  }
  if (/technical|precise|structured|evidence/.test(tone)) {
    return "technical";
  }
  if (/conversation|warm|plainspoken|friendly/.test(tone)) {
    return "conversational";
  }
  if (/humor|funny|witty|comedic/.test(tone)) {
    return "humorous";
  }
  if (/literary|textured|observant|image-rich/.test(tone)) {
    return "literary";
  }
  if (/inspir|encourag|hopeful/.test(tone)) {
    return "inspirational";
  }
  if (/direct|lean|blunt|momentum/.test(tone)) {
    return "direct";
  }
  return "professional";
}

function inferBookWriterProfanityLevel(plan: BookWriterPlan): BookWriterProfanityLevel {
  if (plan.styleGuide?.profanityLevel) {
    return plan.styleGuide.profanityLevel;
  }
  const constraints = plan.brief.constraints.join(" ").toLowerCase();
  if (constraints.includes("extreme profanity")) {
    return "extreme";
  }
  if (constraints.includes("high profanity")) {
    return "high";
  }
  if (constraints.includes("moderate profanity")) {
    return "moderate";
  }
  if (constraints.includes("mild profanity")) {
    return "mild";
  }
  return "none";
}

function syncDraftControlsFromPlan(state: BookWriterDashboardState, plan: BookWriterPlan | null) {
  if (!plan) {
    return;
  }
  const tonePreset = inferBookWriterTonePreset(plan);
  state.bookWriterTargetWordsDraft = plan.targetWords;
  state.bookWriterToneDraft = tonePreset;
  state.bookWriterCustomToneDraft =
    tonePreset === "custom" ? (plan.styleGuide?.toneDescription ?? plan.brief.tone) : "";
  state.bookWriterProfanityDraft = inferBookWriterProfanityLevel(plan);
  state.bookWriterPenNameDraft = plan.penName;
}

function focusFirstBookWriterParagraph(
  state: BookWriterDashboardState,
  plan: BookWriterPlan | null,
) {
  state.bookWriterFocusedParagraphId =
    plan?.chapters.flatMap((chapter) => chapter.paragraphs)[0]?.id ?? null;
}

function applyBookWriterSnapshot(
  state: BookWriterDashboardState,
  snapshot: BookWriterDashboardSnapshot,
) {
  state.bookWriterDashboard = snapshot;
  state.bookWriterSelectedRunId = snapshot.selectedRunId;
  state.bookWriterLastFetchAt = Date.now();
}

function receiptForAction(params: {
  action: string;
  before: BookWriterPlan | null | undefined;
  after: BookWriterDashboardSnapshot;
  requestParams?: Record<string, unknown>;
  beforeSnapshot?: BookWriterDashboardSnapshot | null;
}): BookWriterActionReceipt | null {
  const before = planCounts(params.before);
  const after = planCounts(params.after.plan);
  const titleForRun = (runId: unknown) =>
    typeof runId === "string"
      ? params.beforeSnapshot?.projects.find((project) => project.runId === runId)?.title
      : undefined;
  const titleForDeleted = (deletedId: unknown) =>
    typeof deletedId === "string"
      ? params.beforeSnapshot?.deletedBooks.find((book) => book.deletedId === deletedId)?.title
      : undefined;
  const titleForArchived = (archivedId: unknown) =>
    typeof archivedId === "string"
      ? params.beforeSnapshot?.archivedBooks.find((book) => book.archivedId === archivedId)?.title
      : undefined;
  switch (params.action) {
    case "create":
      return {
        title: `Done. AI made ${after.chapters} chapters.`,
        detail: `${after.paragraphs} paragraph plans are ready to review.`,
        next: "Next: review the chapters, then make the paragraph plan.",
      };
    case "full-draft":
      return {
        title: "Done. AI built your editable draft.",
        detail: `${after.chapters} chapters and ${after.written}/${after.paragraphs} Book Text paragraphs are ready to edit.`,
        next: "Next: read the Book Text, edit anything, then check book quality.",
      };
    case "draft": {
      const writtenNow = Math.max(0, after.written - before.written);
      return {
        title: `Book Writer book-prose-writer wrote ${writtenNow || after.written} paragraphs.`,
        detail: `${after.locked} locked paragraphs were protected by the specialized prose agent.`,
        next: "Next: build the readable book.",
      };
    }
    case "propagate":
      return {
        title: "Done. Story changes were propagated.",
        detail:
          params.after.plan?.bookSync?.summary ?? "Book Studio updated affected editable text.",
        next: "Next: review affected chapters, then build the readable book.",
      };
    case "rebalance":
      return {
        title: "Done. Book structure was rebalanced.",
        detail:
          params.after.plan?.bookSync?.summary ??
          "Book Studio condensed the structure to the new target length.",
        next: "Next: review the condensed Book Text, then build the readable book.",
      };
    case "draft-paragraph":
      return {
        title: "Book Writer book-prose-writer wrote this paragraph.",
        detail: `${after.locked} locked paragraphs were protected by the specialized prose agent.`,
        next: "Next: read the Book Text, edit it if needed, then lock it.",
      };
    case "paragraph-plan-fill":
      return {
        title: "Book Writer paragraph-plan-architect filled the paragraph plan.",
        detail: `${after.paragraphs} paragraph planning cards were checked; locked fields were protected.`,
        next: "Next: review the plan, then go to Write Book Text.",
      };
    case "idea-strategist":
      return {
        title: "Done. Book Writer idea-strategist filled the Idea setup.",
        detail: `${params.after.generationModel.provider}/${params.after.generationModel.model} was used. Profanity stayed Off.`,
        next: "Next: review the idea, then generate or review chapters.",
      };
    case "chapter-architect":
      return {
        title: "Done. Book Writer chapter-architect filled the chapter setup.",
        detail: `${after.locked} locked paragraph(s) were protected; locked chapters were used as continuity anchors.`,
        next: "Next: review chapter titles, plans, and roles before writing paragraphs.",
      };
    case "stitch":
      return {
        title: "Done. Your readable book is built.",
        detail: `${after.written}/${after.paragraphs} paragraphs are now in the reader preview.`,
        next: "Next: read it, then check book quality.",
      };
    case "package":
      return {
        title: "Done. Book quality was checked.",
        detail: params.after.reviewPack
          ? `Result: ${params.after.reviewPack.recommendation}.`
          : "The book check completed.",
        next:
          params.after.reviewPack?.recommendation === "approve"
            ? "Next: prepare publishing."
            : "Next: fix the main issue.",
      };
    case "fix":
      return {
        title: "Done. AI tried to fix the book.",
        detail: params.after.reviewPack
          ? `Book check result: ${params.after.reviewPack.recommendation}.`
          : "The book was repaired and checked again.",
        next:
          params.after.reviewPack?.recommendation === "approve"
            ? "Next: prepare publishing."
            : "Next: review the remaining issue.",
      };
    case "publish":
      return {
        title: "Done. Publishing checklist is prepared.",
        detail: params.after.publishDryRun
          ? `Status: ${params.after.publishDryRun.status}. Final submit is still blocked for you.`
          : "Final submit is still blocked for you.",
        next: "Next: open KDP only when you are ready.",
      };
    case "cover-local-ai":
      return {
        title: "Cover updated.",
        detail: "Book Studio generated a local AI cover or created the fallback concept.",
        next: "Next: review the cover variants and approve the one you want to publish.",
      };
    case "cover-concept":
      return {
        title: "Editable cover concept created.",
        detail: "The local SVG concept is ready to review in the Publish cover section.",
        next: "Next: approve it, upload your own cover, or choose KDP Cover Creator.",
      };
    case "cover-generate":
      return {
        title: "Cover concept generated.",
        detail: "The new concept is ready to review in the Publish cover section.",
        next: "Next: approve it, upload your own cover, or choose KDP Cover Creator.",
      };
    case "cover-upload":
      return {
        title: "Cover uploaded.",
        detail: "The uploaded image is saved with this book for cover review.",
        next: "Next: approve it before publishing prep, or choose KDP Cover Creator.",
      };
    case "cover-approve":
      return {
        title: "Cover approved.",
        detail: "Publishing prep can now use the approved cover route.",
        next: "Next: prepare publishing when the quality check is approved.",
      };
    case "automation-disable":
      return {
        title: "Autonomous writing is off.",
        detail: "Scheduled Book Studio ticks will skip drafting until you explicitly enable them.",
        next: "Next: keep writing manually, or re-enable automation from Advanced scheduling later.",
      };
    case "delete": {
      const title = titleForRun(params.requestParams?.runId) ?? "that book";
      return {
        title: `Moved "${title}" to Recently Deleted.`,
        detail: `${params.after.projects.length} active ${
          params.after.projects.length === 1 ? "book remains" : "books remain"
        }.`,
        next: "Next: restore it or delete it forever from Recently Deleted.",
      };
    }
    case "delete-many": {
      const count = Array.isArray(params.requestParams?.runIds)
        ? params.requestParams.runIds.length
        : 0;
      return {
        title: `Moved ${count || "the selected"} active ${
          count === 1 ? "book" : "books"
        } to Recently Deleted.`,
        detail: `${params.after.projects.length} active ${
          params.after.projects.length === 1 ? "book remains" : "books remain"
        }.`,
        next: "Next: restore any mistake or use Empty Recently Deleted to clear them forever.",
      };
    }
    case "archive": {
      const title = titleForRun(params.requestParams?.runId) ?? "that draft";
      return {
        title: `Archived "${title}".`,
        detail: "It is hidden from active drafts until you restore it.",
        next: "Next: open Archived books in the left rail if you want to restore or delete it.",
      };
    }
    case "copy": {
      const title = titleForRun(params.requestParams?.runId) ?? "that draft";
      return {
        title: `Copied "${title}".`,
        detail:
          "The new editable draft keeps your plan, Book Text, and locks, but clears publish proof.",
        next: "Next: open the copied draft and adjust the idea before writing more.",
      };
    }
    case "unarchive": {
      const title = titleForArchived(params.requestParams?.archivedId) ?? "that archived book";
      return {
        title: `Restored "${title}" to drafts.`,
        detail: `${params.after.projects.length} active ${
          params.after.projects.length === 1 ? "book is" : "books are"
        } now visible.`,
        next: "Next: open the restored draft or continue organizing the library.",
      };
    }
    case "delete-archived": {
      const title = titleForArchived(params.requestParams?.archivedId) ?? "that archived book";
      return {
        title: `Moved "${title}" to Recently Deleted.`,
        detail: "Archived deletion is recoverable from Recently Deleted.",
        next: "Next: restore it from Recently Deleted or delete it forever there.",
      };
    }
    case "restore": {
      const title = titleForDeleted(params.requestParams?.deletedId) ?? "that book";
      return {
        title: `Restored "${title}" to your library.`,
        detail: `${params.after.projects.length} active ${
          params.after.projects.length === 1 ? "book is" : "books are"
        } now visible.`,
        next: "Next: open the restored book or continue cleaning the library.",
      };
    }
    case "delete-forever": {
      const title = titleForDeleted(params.requestParams?.deletedId) ?? "that deleted book";
      return {
        title: `Deleted "${title}" forever.`,
        detail: `${params.after.deletedBooks.length} recoverable ${
          params.after.deletedBooks.length === 1 ? "book remains" : "books remain"
        }.`,
        next: "This cannot be undone.",
      };
    }
    case "empty-deleted":
      return {
        title: "Recently Deleted is empty.",
        detail: "All recoverable deleted books were permanently removed.",
        next: "Next: keep writing, or create a new book idea.",
      };
    case "published-metrics":
      return {
        title: "Published-book stats saved.",
        detail: "Trophy Room recommendations now include the updated sales and profit signal.",
        next: "Next: open the recommendation card when you want the next book idea.",
      };
    case "pen-name":
      return {
        title: "Pen name profile saved.",
        detail: "Future book setup can reuse this lane and reader promise.",
        next: "Next: select the pen name when starting a similar book.",
      };
    default:
      return null;
  }
}

async function requestSnapshot(
  state: BookWriterDashboardState,
  runId?: string | null,
): Promise<BookWriterDashboardSnapshot> {
  if (!state.client || !state.connected) {
    throw new Error("gateway not connected");
  }
  const snapshot = await state.client.request<BookWriterDashboardSnapshot>(
    "bookWriter.dashboard.snapshot",
    runId ? { runId } : {},
  );
  state.bookWriterDashboard = snapshot;
  state.bookWriterSelectedRunId = snapshot.selectedRunId;
  state.bookWriterLastFetchAt = Date.now();
  return snapshot;
}

export async function loadBookWriterDashboard(
  state: BookWriterDashboardState,
  opts?: { runId?: string | null; quiet?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (!opts?.quiet) {
    state.bookWriterLoading = true;
  }
  state.bookWriterError = null;
  state.requestUpdate?.();
  try {
    const requestedRunId = opts && "runId" in opts ? opts.runId : state.bookWriterSelectedRunId;
    const snapshot = await requestSnapshot(state, requestedRunId);
    syncDraftControlsFromPlan(state, snapshot.plan ?? null);
  } catch (error) {
    state.bookWriterError = errorMessage(error);
  } finally {
    state.bookWriterLoading = false;
    state.requestUpdate?.();
  }
}

async function runBookWriterAction(
  state: BookWriterDashboardState,
  action: string,
  method: string,
  params: Record<string, unknown>,
  opts?: { pushUndo?: boolean; timeoutMs?: number },
): Promise<boolean> {
  if (!state.client || !state.connected || state.bookWriterSavingAction) {
    return false;
  }
  const currentPlan = state.bookWriterDashboard?.plan;
  const currentSnapshot = state.bookWriterDashboard;
  if (opts?.pushUndo && currentPlan) {
    state.bookWriterUndoStack = [...state.bookWriterUndoStack, currentPlan].slice(-50);
    state.bookWriterRedoStack = [];
  }
  const previousProjectIds = new Set(
    (state.bookWriterDashboard?.projects ?? []).map((project) => project.runId),
  );
  const previousFinishedIds = new Set(
    (state.bookWriterDashboard?.finishedBooks ?? []).map((book) => book.finishedId),
  );
  state.bookWriterSavingAction = action;
  state.bookWriterError = null;
  state.requestUpdate?.();
  try {
    const snapshot = await state.client.request<BookWriterDashboardSnapshot>(method, params, {
      timeoutMs: opts?.timeoutMs ?? 120_000,
    });
    applyBookWriterSnapshot(state, snapshot);
    state.bookWriterActionReceipt = receiptForAction({
      action,
      before: currentPlan,
      after: snapshot,
      requestParams: params,
      beforeSnapshot: currentSnapshot,
    });
    const newProject =
      action === "create" || action === "full-draft" || action === "quick-read" || action === "copy"
        ? snapshot.projects.find((project) => !previousProjectIds.has(project.runId))
        : undefined;
    const newFinished =
      action === "finish"
        ? snapshot.finishedBooks.find((book) => !previousFinishedIds.has(book.finishedId))
        : undefined;
    if (newProject) {
      state.bookWriterCelebration = {
        id: newProject.runId,
        title: newProject.title,
        kind: "created",
        at: Date.now(),
      };
    } else if (newFinished) {
      state.bookWriterCelebration = {
        id: newFinished.finishedId,
        title: newFinished.title,
        kind: "finished",
        at: Date.now(),
      };
    }
    return true;
  } catch (error) {
    state.bookWriterError = errorMessage(error);
    return false;
  } finally {
    state.bookWriterSavingAction = null;
    state.requestUpdate?.();
  }
}

export async function createBookWriterPlan(state: BookWriterDashboardState) {
  const topic = state.bookWriterTopicDraft.trim();
  if (!topic) {
    state.bookWriterError = "Enter a topic paragraph first.";
    state.requestUpdate?.();
    return;
  }
  const created = await runBookWriterAction(state, "create", "bookWriter.plan.create", {
    topic,
    targetWords: state.bookWriterTargetWordsDraft,
    tonePreset: state.bookWriterToneDraft,
    tone:
      state.bookWriterToneDraft === "custom" ? state.bookWriterCustomToneDraft.trim() : undefined,
    profanityLevel: state.bookWriterProfanityDraft,
    penName: state.bookWriterPenNameDraft.trim() || undefined,
  });
  if (created) {
    const plan = state.bookWriterDashboard?.plan;
    syncDraftControlsFromPlan(state, plan ?? null);
    state.bookWriterNewBookSetupOpen = false;
    state.bookWriterMode = "guided";
    state.bookWriterActiveView = "chapters";
    state.requestUpdate?.();
  }
}

export async function createBookWriterFullDraft(state: BookWriterDashboardState) {
  if (!state.client || !state.connected || state.bookWriterSavingAction) {
    return;
  }
  const startingSnapshot = state.bookWriterDashboard;
  const startingPlan = startingSnapshot?.plan ?? null;
  const topic = state.bookWriterTopicDraft.trim();
  if (!startingPlan && !topic) {
    state.bookWriterError = "Enter a book description first.";
    state.requestUpdate?.();
    return;
  }
  if (startingPlan) {
    state.bookWriterUndoStack = [...state.bookWriterUndoStack, startingPlan].slice(-50);
    state.bookWriterRedoStack = [];
  }
  const previousProjectIds = new Set(startingSnapshot?.projects.map((project) => project.runId));
  let snapshot = startingSnapshot;
  state.bookWriterError = null;
  state.bookWriterActionReceipt = null;
  state.bookWriterNewBookSetupOpen = false;
  state.bookWriterMode = "guided";
  try {
    if (!startingPlan) {
      state.bookWriterSavingAction = "full-draft-chapters";
      state.bookWriterActiveView = "chapters";
      state.requestUpdate?.();
      snapshot = await state.client.request<BookWriterDashboardSnapshot>(
        "bookWriter.plan.create",
        {
          topic,
          targetWords: state.bookWriterTargetWordsDraft,
          tonePreset: state.bookWriterToneDraft,
          tone:
            state.bookWriterToneDraft === "custom"
              ? state.bookWriterCustomToneDraft.trim()
              : undefined,
          profanityLevel: state.bookWriterProfanityDraft,
          penName: state.bookWriterPenNameDraft.trim() || undefined,
        },
        { timeoutMs: 300_000 },
      );
      applyBookWriterSnapshot(state, snapshot);
      syncDraftControlsFromPlan(state, snapshot.plan ?? null);
      const newProject = snapshot.projects.find(
        (project) => !previousProjectIds.has(project.runId),
      );
      if (newProject) {
        state.bookWriterCelebration = {
          id: newProject.runId,
          title: newProject.title,
          kind: "created",
          at: Date.now(),
        };
      }
      state.requestUpdate?.();
    } else {
      syncDraftControlsFromPlan(state, startingPlan);
    }

    if (!snapshot?.plan) {
      throw new Error("AI could not create a book plan to continue.");
    }

    state.bookWriterSavingAction = "full-draft-paragraphs";
    state.bookWriterActiveView = "paragraphs";
    state.requestUpdate?.();

    if (needsBookText(snapshot.plan)) {
      state.bookWriterSavingAction = "full-draft-text";
      state.bookWriterActiveView = "draft";
      state.requestUpdate?.();
      snapshot = await state.client.request<BookWriterDashboardSnapshot>(
        "bookWriter.plan.draft",
        { runId: snapshot.plan.runId, baseVersion: snapshot.plan.version },
        { timeoutMs: 300_000 },
      );
      applyBookWriterSnapshot(state, snapshot);
      state.requestUpdate?.();
    }

    if (!hasReadablePreview(snapshot)) {
      if (!snapshot?.plan) {
        throw new Error("AI could not find the book plan before building the readable preview.");
      }
      state.bookWriterSavingAction = "full-draft-preview";
      state.bookWriterActiveView = "draft";
      state.requestUpdate?.();
      snapshot = await state.client.request<BookWriterDashboardSnapshot>(
        "bookWriter.plan.stitch",
        { runId: snapshot.plan.runId, baseVersion: snapshot.plan.version },
        { timeoutMs: 300_000 },
      );
      applyBookWriterSnapshot(state, snapshot);
    }

    syncDraftControlsFromPlan(state, snapshot.plan ?? null);
    state.bookWriterActiveView = "draft";
    focusFirstBookWriterParagraph(state, snapshot.plan ?? null);
    state.bookWriterActionReceipt = receiptForAction({
      action: "full-draft",
      before: startingPlan,
      after: snapshot,
      beforeSnapshot: startingSnapshot,
    });
  } catch (error) {
    state.bookWriterError = errorMessage(error);
  } finally {
    state.bookWriterSavingAction = null;
    state.requestUpdate?.();
  }
}

export async function saveBookWriterPlan(state: BookWriterDashboardState, plan: BookWriterPlan) {
  await runBookWriterAction(
    state,
    "save",
    "bookWriter.plan.save",
    { plan, baseVersion: state.bookWriterDashboard?.plan?.version },
    { pushUndo: true },
  );
}

export async function requestBookWriterSetupAiHelp(
  state: BookWriterDashboardState,
  intent: BookWriterAiHelpIntent,
  customDirection?: string,
) {
  if (!state.client || !state.connected || state.bookWriterSavingAction) {
    return;
  }
  state.bookWriterSavingAction = "setup-ai-help";
  state.bookWriterError = null;
  state.requestUpdate?.();
  try {
    const suggestion = await state.client.request<BookWriterAiHelpSuggestion>(
      "bookWriter.plan.suggestSetupField",
      {
        topic: state.bookWriterTopicDraft,
        targetWords: state.bookWriterTargetWordsDraft,
        tonePreset: state.bookWriterToneDraft,
        tone:
          state.bookWriterToneDraft === "custom"
            ? state.bookWriterCustomToneDraft.trim()
            : undefined,
        profanityLevel: state.bookWriterProfanityDraft,
        penName: state.bookWriterPenNameDraft.trim() || undefined,
        intent,
        ...(customDirection?.trim() ? { customDirection: customDirection.trim() } : {}),
      },
      { timeoutMs: 120_000 },
    );
    state.bookWriterTopicDraft = suggestion.suggestion;
    state.bookWriterActionReceipt = {
      title: "AI updated the book description",
      detail:
        "The setup textbox changed without creating a book. Review it, edit it, then choose when AI should build the draft.",
      next: "Click Write my editable draft when you are ready.",
    };
  } catch (error) {
    state.bookWriterError = errorMessage(error);
  } finally {
    state.bookWriterSavingAction = null;
    state.requestUpdate?.();
  }
}

export async function requestBookWriterAiHelp(
  state: BookWriterDashboardState,
  request: BookWriterAiHelpRequest,
) {
  const plan = state.bookWriterDashboard?.plan;
  if (!state.client || !state.connected || !plan) {
    return;
  }
  state.bookWriterSavingAction = "ai-help";
  state.bookWriterError = null;
  state.requestUpdate?.();
  try {
    const suggestion = await state.client.request<BookWriterAiHelpSuggestion>(
      "bookWriter.plan.suggestField",
      {
        runId: plan.runId,
        ...request,
      },
      { timeoutMs: 120_000 },
    );
    const nextPlan = applySuggestionToPlan(plan, suggestion, suggestion.suggestion);
    if (nextPlan === plan) {
      state.bookWriterError = "That field is locked, so AI left it unchanged.";
      return;
    }
    state.bookWriterUndoStack = [...state.bookWriterUndoStack, plan].slice(-50);
    state.bookWriterRedoStack = [];
    state.bookWriterSavingAction = null;
    await runBookWriterAction(
      state,
      "save",
      "bookWriter.plan.save",
      {
        plan: nextPlan,
        baseVersion: state.bookWriterDashboard?.plan?.version,
      },
      { pushUndo: false },
    );
    state.bookWriterActionReceipt = {
      title: "AI updated the field",
      detail: "The textbox was changed with full book context. You can keep editing or undo it.",
      next: "Review the changed text in place.",
    };
  } catch (error) {
    state.bookWriterError = errorMessage(error);
  } finally {
    state.bookWriterSavingAction = null;
    state.requestUpdate?.();
  }
}

export async function applyBookWriterAiSuggestion(
  state: BookWriterDashboardState,
  suggestion: BookWriterAiHelpSuggestion,
  value?: string,
) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  const nextValue = value ?? suggestion.suggestion;
  const nextPlan = applySuggestionToPlan(plan, suggestion, nextValue);
  state.bookWriterPendingAiSuggestion = null;
  await saveBookWriterPlan(state, nextPlan);
}

export function cancelBookWriterAiSuggestion(state: BookWriterDashboardState) {
  state.bookWriterPendingAiSuggestion = null;
  state.requestUpdate?.();
}

function applySuggestionToPlan(
  plan: BookWriterPlan,
  suggestion: BookWriterAiHelpSuggestion,
  value: string,
): BookWriterPlan {
  switch (suggestion.target) {
    case "title":
      return { ...plan, title: value };
    case "bookStyle":
      return {
        ...plan,
        brief: { ...plan.brief, tone: value },
        styleGuide: {
          tonePreset: "custom",
          toneDescription: value,
          profanityLevel: plan.styleGuide?.profanityLevel ?? "none",
          profanityDescription: plan.styleGuide?.profanityDescription ?? "Clean language.",
        },
      };
    case "topic":
      return { ...plan, topic: value, brief: { ...plan.brief, topicParagraph: value } };
    case "audience":
      return { ...plan, brief: { ...plan.brief, audience: value } };
    case "readerPromise":
      return { ...plan, brief: { ...plan.brief, readerPromise: value } };
    case "chapterDescription":
      return suggestion.chapterId
        ? updateChapter(plan, suggestion.chapterId, (chapter) => ({
            ...chapter,
            description:
              chapter.locked || chapter.fieldLocks?.description ? chapter.description : value,
          }))
        : plan;
    case "chapterTitle":
      return suggestion.chapterId
        ? updateChapter(plan, suggestion.chapterId, (chapter) => ({
            ...chapter,
            title: chapter.locked || chapter.fieldLocks?.title ? chapter.title : value,
          }))
        : plan;
    case "chapterStyle":
      return suggestion.chapterId
        ? updateChapter(plan, suggestion.chapterId, (chapter) => ({
            ...chapter,
            styleDirection:
              chapter.locked || chapter.fieldLocks?.styleDirection ? chapter.styleDirection : value,
          }))
        : plan;
    case "paragraphSummary":
      return suggestion.chapterId && suggestion.paragraphId
        ? updateParagraph(plan, suggestion.chapterId, suggestion.paragraphId, (paragraph) => ({
            ...paragraph,
            summary: paragraph.locked || paragraph.fieldLocks?.summary ? paragraph.summary : value,
          }))
        : plan;
    case "paragraphTitle":
      return suggestion.chapterId && suggestion.paragraphId
        ? updateParagraph(plan, suggestion.chapterId, suggestion.paragraphId, (paragraph) => ({
            ...paragraph,
            title: paragraph.locked || paragraph.fieldLocks?.title ? paragraph.title : value,
          }))
        : plan;
    case "paragraphPlan":
      return suggestion.chapterId && suggestion.paragraphId
        ? updateParagraph(plan, suggestion.chapterId, suggestion.paragraphId, (paragraph) => ({
            ...paragraph,
            purpose: paragraph.locked || paragraph.fieldLocks?.purpose ? paragraph.purpose : value,
          }))
        : plan;
    case "paragraphStyle":
      return suggestion.chapterId && suggestion.paragraphId
        ? updateParagraph(plan, suggestion.chapterId, suggestion.paragraphId, (paragraph) => ({
            ...paragraph,
            styleDirection:
              paragraph.locked || paragraph.fieldLocks?.styleDirection
                ? paragraph.styleDirection
                : value,
          }))
        : plan;
    case "paragraphText":
      return suggestion.chapterId && suggestion.paragraphId
        ? updateParagraph(plan, suggestion.chapterId, suggestion.paragraphId, (paragraph) => {
            const locked = paragraph.locked || paragraph.fieldLocks?.text;
            return {
              ...paragraph,
              text: locked ? paragraph.text : value,
              status: locked ? paragraph.status : "drafted",
            };
          })
        : plan;
    case "coverBrief":
      return { ...plan, cover: { ...plan.cover, brief: value } };
    case "coverPrompt":
      return { ...plan, cover: { ...plan.cover, prompt: value } };
  }
  return plan;
}

function updateChapter(
  plan: BookWriterPlan,
  chapterId: string,
  updater: (chapter: BookWriterChapter) => BookWriterChapter,
): BookWriterPlan {
  return {
    ...plan,
    chapters: plan.chapters.map((chapter) =>
      chapter.id === chapterId ? updater(chapter) : chapter,
    ),
  };
}

function updateParagraph(
  plan: BookWriterPlan,
  chapterId: string,
  paragraphId: string,
  updater: (paragraph: BookWriterParagraph) => BookWriterParagraph,
): BookWriterPlan {
  return updateChapter(plan, chapterId, (chapter) => ({
    ...chapter,
    paragraphs: chapter.paragraphs.map((paragraph) =>
      paragraph.id === paragraphId ? updater(paragraph) : paragraph,
    ),
  }));
}

export async function deleteBookWriterPlan(state: BookWriterDashboardState, runId: string) {
  if (!runId) {
    return;
  }
  await runBookWriterAction(state, "delete", "bookWriter.plan.delete", {
    runId,
    selectedRunId: state.bookWriterSelectedRunId,
  });
  state.bookWriterUndoStack = [];
  state.bookWriterRedoStack = [];
}

export async function deleteActiveBookWriterPlans(
  state: BookWriterDashboardState,
  runIds: string[],
) {
  const uniqueRunIds = [...new Set(runIds.map((runId) => runId.trim()).filter(Boolean))];
  if (!uniqueRunIds.length) {
    return;
  }
  await runBookWriterAction(state, "delete-many", "bookWriter.plan.deleteMany", {
    runIds: uniqueRunIds,
    selectedRunId: state.bookWriterSelectedRunId,
  });
  state.bookWriterUndoStack = [];
  state.bookWriterRedoStack = [];
}

export async function archiveBookWriterPlan(state: BookWriterDashboardState, runId: string) {
  if (!runId) {
    return;
  }
  await runBookWriterAction(state, "archive", "bookWriter.plan.archive", {
    runId,
    selectedRunId: state.bookWriterSelectedRunId,
  });
  state.bookWriterUndoStack = [];
  state.bookWriterRedoStack = [];
}

export async function copyBookWriterPlan(state: BookWriterDashboardState, runId: string) {
  if (!runId) {
    return;
  }
  const copied = await runBookWriterAction(state, "copy", "bookWriter.plan.copy", { runId });
  if (copied) {
    state.bookWriterNewBookSetupOpen = false;
    state.bookWriterMode = "guided";
    state.bookWriterActiveView = "brief";
    state.requestUpdate?.();
  }
}

export async function restoreArchivedBookWriterPlan(
  state: BookWriterDashboardState,
  archivedId: string,
) {
  if (!archivedId) {
    return;
  }
  await runBookWriterAction(state, "unarchive", "bookWriter.plan.unarchive", { archivedId });
  state.bookWriterUndoStack = [];
  state.bookWriterRedoStack = [];
}

export async function deleteArchivedBookWriterPlan(
  state: BookWriterDashboardState,
  archivedId: string,
) {
  if (!archivedId) {
    return;
  }
  await runBookWriterAction(state, "delete-archived", "bookWriter.plan.deleteArchived", {
    archivedId,
  });
  state.bookWriterUndoStack = [];
  state.bookWriterRedoStack = [];
}

export async function restoreDeletedBookWriterPlan(
  state: BookWriterDashboardState,
  deletedId: string,
) {
  if (!deletedId) {
    return;
  }
  await runBookWriterAction(state, "restore", "bookWriter.plan.restore", { deletedId });
  state.bookWriterUndoStack = [];
  state.bookWriterRedoStack = [];
}

export async function deleteDeletedBookWriterPlan(
  state: BookWriterDashboardState,
  deletedId: string,
) {
  if (!deletedId) {
    return;
  }
  await runBookWriterAction(state, "delete-forever", "bookWriter.plan.deleteDeleted", {
    deletedId,
  });
  state.bookWriterUndoStack = [];
  state.bookWriterRedoStack = [];
}

export async function emptyDeletedBookWriterPlans(state: BookWriterDashboardState) {
  await runBookWriterAction(state, "empty-deleted", "bookWriter.plan.emptyDeleted", {});
  state.bookWriterUndoStack = [];
  state.bookWriterRedoStack = [];
}

export async function finishBookWriterPlan(
  state: BookWriterDashboardState,
  runId: string,
  proof?: Partial<BookWriterPublishedProof>,
) {
  if (!runId) {
    return;
  }
  if (!proof?.operatorConfirmed) {
    state.bookWriterError =
      "Confirm the book was actually published before moving it to Trophy Room.";
    state.requestUpdate?.();
    return;
  }
  await runBookWriterAction(state, "finish", "bookWriter.plan.markPublished", {
    runId,
    selectedRunId: state.bookWriterSelectedRunId,
    ...(proof ? { proof } : {}),
  });
  state.bookWriterUndoStack = [];
  state.bookWriterRedoStack = [];
}

export async function restoreFinishedBookWriterPlan(
  state: BookWriterDashboardState,
  finishedId: string,
) {
  if (!finishedId) {
    return;
  }
  await runBookWriterAction(state, "restore", "bookWriter.plan.unfinish", { finishedId });
  state.bookWriterUndoStack = [];
  state.bookWriterRedoStack = [];
}

export async function updatePublishedBookWriterMetrics(
  state: BookWriterDashboardState,
  finishedId: string,
  metrics: Partial<BookWriterPublishedMetrics>,
) {
  if (!finishedId) {
    return;
  }
  await runBookWriterAction(state, "published-metrics", "bookWriter.published.updateMetrics", {
    finishedId,
    metrics,
  });
}

export async function draftBookWriterPlan(state: BookWriterDashboardState) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  const drafted = await runBookWriterAction(
    state,
    "draft",
    "bookWriter.plan.draft",
    { runId: plan.runId, baseVersion: plan.version },
    { pushUndo: true },
  );
  if (drafted) {
    state.bookWriterActiveView = "draft";
    focusFirstBookWriterParagraph(state, state.bookWriterDashboard?.plan ?? null);
    state.requestUpdate?.();
  }
}

export async function fillBookWriterParagraphPlans(
  state: BookWriterDashboardState,
  chapterId?: string,
) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  await runBookWriterAction(
    state,
    "paragraph-plan-fill",
    "bookWriter.plan.fillPlanSection",
    {
      runId: plan.runId,
      baseVersion: plan.version,
      ...(chapterId ? { chapterId } : {}),
    },
    { pushUndo: true, timeoutMs: 180_000 },
  );
}

export async function generateBookWriterIdeaSetup(
  state: BookWriterDashboardState,
  targets: BookWriterIdeaSetupTarget[],
) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  await runBookWriterAction(
    state,
    "idea-strategist",
    "bookWriter.plan.generateIdeaSetup",
    {
      runId: plan.runId,
      baseVersion: plan.version,
      targets,
    },
    { pushUndo: true, timeoutMs: 180_000 },
  );
}

export async function generateBookWriterChapterSetup(
  state: BookWriterDashboardState,
  targets: BookWriterChapterSetupTarget[],
) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  await runBookWriterAction(
    state,
    "chapter-architect",
    "bookWriter.plan.generateChapterSetup",
    {
      runId: plan.runId,
      baseVersion: plan.version,
      targets,
    },
    { pushUndo: true, timeoutMs: 240_000 },
  );
}

export async function updateBookWriterPenNameProfile(
  state: BookWriterDashboardState,
  profile: { name: string; lane: string; readerPromise: string },
) {
  await runBookWriterAction(state, "pen-name", "bookWriter.penNames.update", {
    ...profile,
    runId: state.bookWriterSelectedRunId,
  });
}

export async function draftBookWriterParagraph(
  state: BookWriterDashboardState,
  paragraphId: string,
  replaceExisting = false,
) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan || !paragraphId) {
    return;
  }
  await runBookWriterAction(
    state,
    "draft-paragraph",
    "bookWriter.plan.draftParagraph",
    {
      runId: plan.runId,
      baseVersion: plan.version,
      paragraphId,
      replaceExisting,
    },
    { pushUndo: true },
  );
}

export async function propagateBookWriterStoryChange(state: BookWriterDashboardState) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  await runBookWriterAction(
    state,
    "propagate",
    "bookWriter.plan.propagateStoryChange",
    { runId: plan.runId, baseVersion: plan.version },
    { pushUndo: true, timeoutMs: 300_000 },
  );
}

export async function rebalanceBookWriterStructure(state: BookWriterDashboardState) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  await runBookWriterAction(
    state,
    "rebalance",
    "bookWriter.plan.rebalance",
    { runId: plan.runId, baseVersion: plan.version, targetWords: plan.targetWords },
    { pushUndo: true, timeoutMs: 300_000 },
  );
}

export async function stitchBookWriterPlan(state: BookWriterDashboardState) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  const stitched = await runBookWriterAction(
    state,
    "stitch",
    "bookWriter.plan.stitch",
    { runId: plan.runId, baseVersion: plan.version },
    { pushUndo: true },
  );
  if (stitched) {
    state.bookWriterActiveView = "package";
    state.requestUpdate?.();
  }
}

export async function packageBookWriterPlan(state: BookWriterDashboardState) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  const packaged = await runBookWriterAction(
    state,
    "package",
    "bookWriter.plan.package",
    { runId: plan.runId, baseVersion: plan.version },
    { pushUndo: true, timeoutMs: 300_000 },
  );
  if (packaged) {
    state.bookWriterActiveView = "package";
    state.requestUpdate?.();
  }
}

export async function fixBookWriterPlan(state: BookWriterDashboardState) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  await runBookWriterAction(
    state,
    "fix",
    "bookWriter.plan.fix",
    { runId: plan.runId, baseVersion: plan.version },
    { pushUndo: true, timeoutMs: 300_000 },
  );
}

export async function prepareBookWriterPublish(state: BookWriterDashboardState) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  const prepared = await runBookWriterAction(state, "publish", "bookWriter.publish.prepare", {
    runId: plan.runId,
  });
  if (prepared) {
    state.bookWriterActiveView = "publish";
    state.requestUpdate?.();
  }
}

export async function prepareBookWriterPublishWithCoverStrategy(
  state: BookWriterDashboardState,
  coverStrategy: "upload" | "kdp-cover-creator",
) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  const prepared = await runBookWriterAction(state, "publish", "bookWriter.publish.prepare", {
    runId: plan.runId,
    coverStrategy,
  });
  if (prepared) {
    state.bookWriterActiveView = "publish";
    state.requestUpdate?.();
  }
}

export async function generateBookWriterCoverConcept(state: BookWriterDashboardState) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  await runBookWriterAction(
    state,
    "cover-local-ai",
    "bookWriter.cover.generateLocalImage",
    { runId: plan.runId, baseVersion: plan.version },
    { pushUndo: true },
  );
}

export async function generateBookWriterEditableCoverConcept(state: BookWriterDashboardState) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  await runBookWriterAction(
    state,
    "cover-concept",
    "bookWriter.cover.generateConcept",
    { runId: plan.runId, baseVersion: plan.version },
    { pushUndo: true },
  );
}

export async function editBookWriterCoverWithLocalAi(
  state: BookWriterDashboardState,
  variantId: string | undefined,
  instruction: string,
) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  await runBookWriterAction(
    state,
    "cover-local-ai",
    "bookWriter.cover.editLocalImage",
    { runId: plan.runId, baseVersion: plan.version, variantId, instruction },
    { pushUndo: true },
  );
}

export async function approveBookWriterCover(state: BookWriterDashboardState, variantId?: string) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  await runBookWriterAction(
    state,
    "cover-approve",
    "bookWriter.cover.approve",
    { runId: plan.runId, baseVersion: plan.version, variantId },
    { pushUndo: true },
  );
}

export async function uploadBookWriterCoverFile(state: BookWriterDashboardState, file: File) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  await runBookWriterAction(
    state,
    "cover-upload",
    "bookWriter.cover.upload",
    {
      runId: plan.runId,
      baseVersion: plan.version,
      fileName: file.name,
      mimeType: file.type,
      dataBase64: btoa(binary),
    },
    { pushUndo: true, timeoutMs: 180_000 },
  );
}

export async function disableBookWriterAutomation(state: BookWriterDashboardState) {
  await runBookWriterAction(state, "automation-disable", "bookWriter.automation.disable", {});
}

export async function createBookWriterQuickRead(state: BookWriterDashboardState) {
  const plan = state.bookWriterDashboard?.plan;
  if (!plan) {
    return;
  }
  await runBookWriterAction(state, "quick-read", "bookWriter.plan.quickRead", {
    sourceRunId: plan.runId,
  });
}

export async function undoBookWriterEdit(state: BookWriterDashboardState) {
  const current = state.bookWriterDashboard?.plan;
  const previous = state.bookWriterUndoStack.at(-1);
  if (!current || !previous) {
    return;
  }
  state.bookWriterUndoStack = state.bookWriterUndoStack.slice(0, -1);
  state.bookWriterRedoStack = [...state.bookWriterRedoStack, current].slice(-50);
  await runBookWriterAction(state, "undo", "bookWriter.plan.save", {
    plan: previous,
    baseVersion: current.version,
  });
}

export async function redoBookWriterEdit(state: BookWriterDashboardState) {
  const current = state.bookWriterDashboard?.plan;
  const next = state.bookWriterRedoStack.at(-1);
  if (!current || !next) {
    return;
  }
  state.bookWriterRedoStack = state.bookWriterRedoStack.slice(0, -1);
  state.bookWriterUndoStack = [...state.bookWriterUndoStack, current].slice(-50);
  await runBookWriterAction(state, "redo", "bookWriter.plan.save", {
    plan: next,
    baseVersion: current.version,
  });
}
