import type { GatewayBrowserClient } from "../gateway.ts";

export type AppStudioStageId =
  | "idea"
  | "blueprint"
  | "build"
  | "preview"
  | "testflight"
  | "app-store";

export type AppStudioGateId =
  | "model-check"
  | "validate-structure"
  | "validate-build"
  | "screenshots"
  | "app-store-ready"
  | "publish-plan"
  | "final-verify"
  | "ready"
  | "implement"
  | "repair"
  | "builder-task";

export type AppStudioBuildEngine = "local-qwen" | "codex";

export type AppStudioAgentWorkStatus = "idle" | "queued" | "running" | "blocked" | "done";

export type AppStudioAgentWorkItem = {
  id: string;
  label: string;
  role: string;
  modelRef: string;
  status: AppStudioAgentWorkStatus;
  currentTask: string;
  inputs: string[];
  outputs: string[];
  blockedOn: string[];
  lastEvent: string;
  updatedAt: string;
};

export type AppStudioBuildEngineOption = {
  id: AppStudioBuildEngine;
  label: string;
  modelRef: string;
  detail: string;
  privacy: "local" | "cloud";
};

export type AppStudioScreen = {
  id: string;
  title: string;
  purpose: string;
};

export type AppStudioScreenFlowEdge = {
  id: string;
  fromScreenId: string;
  toScreenId: string;
  label: string;
  trigger: string;
};

export type AppStudioScreenFlow = {
  entryScreenId: string;
  edges: AppStudioScreenFlowEdge[];
};

export type AppStudioDataModel = {
  name: string;
  purpose: string;
  fields: string[];
};

export type AppStudioPromptEntry = {
  id: string;
  prompt: string;
  at: string;
  summary: string;
};

export type AppStudioProductSpec = {
  schemaVersion: number;
  appId: string;
  appName: string;
  moduleName: string;
  bundleId: string;
  originalRequest: string;
  goal: string;
  audience: string;
  appleCategory: string;
  screens: AppStudioScreen[];
  screenFlow?: AppStudioScreenFlow;
  dataModel: AppStudioDataModel[];
  acceptanceCriteria: string[];
  unresolvedQuestions: string[];
  privacyPosture: {
    collectsPersonalData: boolean;
    tracking: boolean;
    networkAccess: boolean;
    notes: string[];
  };
};

export type AppStudioApproval = {
  id: string;
  label: string;
  status: "blocked" | "approved";
  approvedAt?: string;
};

export type AppStudioVisualReference = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storedPath: string;
  importedAt: string;
  notes: string;
};

export type AppStudioProjectRecord = {
  schemaVersion: 1;
  appId: string;
  appDir: string;
  createdAt: string;
  updatedAt: string;
  buildEngine: AppStudioBuildEngine;
  promptHistory: AppStudioPromptEntry[];
  visualInputs: AppStudioVisualReference[];
  agentWorkboard: AppStudioAgentWorkItem[];
  approvals: AppStudioApproval[];
  appleFacts: {
    appStoreConnectAppId: string;
    sku: string;
    teamId: string;
    apiKeyProfileRef: string;
  };
  xcodeHandoff: {
    recommended: boolean;
    reason: string;
  };
};

export type AppStudioProjectSummary = {
  appId: string;
  appName: string;
  appDir: string;
  bundleId: string;
  updatedAt: string;
  stage: AppStudioStageId;
  completionGrade: number;
  criticality: number;
  nextAction: string;
  readyToBuild: boolean;
  readyForAppStore: boolean;
};

export type AppStudioActivityEvent = {
  at: string;
  stage: string;
  result: string;
  summary: string;
};

export type AppStudioSelectedProject = AppStudioProjectSummary & {
  spec: AppStudioProductSpec;
  studio: AppStudioProjectRecord;
  screens: AppStudioScreen[];
  screenFlow: AppStudioScreenFlow;
  dataModel: AppStudioDataModel[];
  prompts: AppStudioPromptEntry[];
  visualInputs: AppStudioVisualReference[];
  activity: AppStudioActivityEvent[];
  appStoreConnect: Record<string, unknown>;
  metadata: Record<string, unknown>;
  latestReports: Record<string, Record<string, unknown> | null>;
};

export type AppStudioDashboardSnapshot = {
  schemaVersion: 1;
  checkedAt: string;
  projects: AppStudioProjectSummary[];
  selectedProject: AppStudioSelectedProject | null;
  defaultPrompt: string;
  buildEngineOptions: AppStudioBuildEngineOption[];
  stages: Array<{ id: AppStudioStageId; label: string; detail: string }>;
  gates: Array<{ id: AppStudioGateId; label: string; detail: string; requiresApproval: boolean }>;
  nextAction: string;
};

export type AppStudioActionReceipt = {
  title: string;
  detail: string;
  next: string;
};

export type AppStudioActionResult = {
  snapshot: AppStudioDashboardSnapshot;
  receipt: AppStudioActionReceipt;
};

export type AppStudioAppleFactsDraft = {
  appStoreConnectAppId: string;
  sku: string;
  teamId: string;
  signingIdentity: string;
  provisioningProfile: string;
  apiKeyProfileRef: string;
  supportUrl: string;
  privacyUrl: string;
  reviewContactName: string;
  reviewContactEmail: string;
  reviewContactPhone: string;
};

export type AppStudioScreenImageDraft = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
};

export type AppStudioFlowDraft = {
  fromScreenId: string;
  toScreenId: string;
  label: string;
  trigger: string;
};

export type AppStudioDashboardState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  appStudioLoading: boolean;
  appStudioError: string | null;
  appStudioDashboard: AppStudioDashboardSnapshot | null;
  appStudioLastFetchAt: number | null;
  appStudioSelectedAppDir: string | null;
  appStudioPromptDraft: string;
  appStudioCreateNameDraft: string;
  appStudioCreateAppIdDraft: string;
  appStudioCreateBundleIdDraft: string;
  appStudioSavingAction: string | null;
  appStudioActionReceipt: AppStudioActionReceipt | null;
  appStudioAppleFactsDraft: AppStudioAppleFactsDraft;
  appStudioBuildEngineDraft: AppStudioBuildEngine;
  appStudioScreenImageDrafts: AppStudioScreenImageDraft[];
  appStudioScreenImageNotesDraft: string;
  appStudioScreenAnalysisDraft: string;
  appStudioFlowDraft: AppStudioFlowDraft;
  appStudioLivePollTimer: ReturnType<typeof setInterval> | null;
  appStudioLivePollAppDir: string | null;
  appStudioActionStartedAt: number | null;
  requestUpdate?: () => void;
};

export const DEFAULT_APP_STUDIO_PROMPT =
  "Create a polished, private, local-only iPhone app. No accounts, no analytics, no ads, no tracking, no location, no contacts, no health data, and no network dependency.";

export const DEFAULT_APP_STUDIO_APPLE_FACTS: AppStudioAppleFactsDraft = {
  appStoreConnectAppId: "",
  sku: "",
  teamId: "",
  signingIdentity: "",
  provisioningProfile: "",
  apiKeyProfileRef: "",
  supportUrl: "",
  privacyUrl: "",
  reviewContactName: "",
  reviewContactEmail: "",
  reviewContactPhone: "",
};

export const DEFAULT_APP_STUDIO_BUILD_ENGINE: AppStudioBuildEngine = "local-qwen";

export const DEFAULT_APP_STUDIO_FLOW_DRAFT: AppStudioFlowDraft = {
  fromScreenId: "",
  toScreenId: "",
  label: "",
  trigger: "",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasActiveWorkboard(selected: AppStudioSelectedProject | null | undefined): boolean {
  return (
    selected?.studio.agentWorkboard.some(
      (agent) => agent.status === "running" || agent.status === "queued",
    ) ?? false
  );
}

function clearLivePoll(state: AppStudioDashboardState) {
  if (state.appStudioLivePollTimer) {
    clearInterval(state.appStudioLivePollTimer);
    state.appStudioLivePollTimer = null;
    state.appStudioLivePollAppDir = null;
  }
}

function scheduleSnapshotPoll(state: AppStudioDashboardState, appDir: string | null) {
  if (!appDir || !state.connected || !state.client) {
    clearLivePoll(state);
    return;
  }
  const shouldPoll =
    state.appStudioSavingAction || hasActiveWorkboard(state.appStudioDashboard?.selectedProject);
  if (!shouldPoll || state.appStudioDashboard?.selectedProject?.appDir !== appDir) {
    if (!shouldPoll) {
      clearLivePoll(state);
    }
    return;
  }
  if (state.appStudioLivePollTimer !== null && state.appStudioLivePollAppDir === appDir) {
    return;
  }
  clearLivePoll(state);
  let polling = false;
  const poll = async () => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      await requestSnapshot(state, appDir);
      const selected = state.appStudioDashboard?.selectedProject;
      const stillActive = state.appStudioSavingAction || hasActiveWorkboard(selected);
      if (!stillActive || selected?.appDir !== appDir) {
        clearLivePoll(state);
      }
    } catch (error) {
      state.appStudioError = errorMessage(error);
      state.requestUpdate?.();
      clearLivePoll(state);
    } finally {
      polling = false;
    }
  };
  state.appStudioLivePollTimer = setInterval(poll, 1500);
  state.appStudioLivePollAppDir = appDir;
  void poll();
}

function buildAppleFactsDraft(selected: AppStudioSelectedProject | null): AppStudioAppleFactsDraft {
  const draftString = (value: unknown): string =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
  const connect = selected?.appStoreConnect ?? {};
  const metadata = selected?.metadata ?? {};
  const reviewContact =
    typeof metadata.reviewContact === "object" && metadata.reviewContact !== null
      ? (metadata.reviewContact as Record<string, unknown>)
      : {};
  return {
    appStoreConnectAppId: draftString(connect.appStoreConnectAppId),
    sku: draftString(connect.sku ?? selected?.studio.appleFacts.sku),
    teamId: draftString(connect.teamId ?? selected?.studio.appleFacts.teamId),
    signingIdentity: draftString(connect.signingIdentity),
    provisioningProfile: draftString(connect.provisioningProfile),
    apiKeyProfileRef: draftString(
      connect.apiKeyProfileRef ?? selected?.studio.appleFacts.apiKeyProfileRef ?? "",
    ),
    supportUrl: draftString(metadata.supportUrl),
    privacyUrl: draftString(metadata.privacyUrl),
    reviewContactName: draftString(reviewContact.name),
    reviewContactEmail: draftString(reviewContact.email),
    reviewContactPhone: draftString(reviewContact.phone),
  };
}

function defaultFlowDraft(
  selected: AppStudioSelectedProject | null,
  current: AppStudioFlowDraft,
): AppStudioFlowDraft {
  if (!selected || selected.screens.length < 2) {
    return DEFAULT_APP_STUDIO_FLOW_DRAFT;
  }
  const validFrom = selected.screens.some((screen) => screen.id === current.fromScreenId);
  const validTo =
    selected.screens.some((screen) => screen.id === current.toScreenId) &&
    current.toScreenId !== current.fromScreenId;
  const fromScreenId = validFrom ? current.fromScreenId : (selected.screens[0]?.id ?? "");
  const fallbackTarget =
    selected.screens.find((screen) => screen.id !== fromScreenId) ?? selected.screens[1];
  const toScreenId = validTo ? current.toScreenId : (fallbackTarget?.id ?? "");
  const target = selected.screens.find((screen) => screen.id === toScreenId);
  return {
    fromScreenId,
    toScreenId,
    label: current.label || `Open ${target?.title ?? "screen"}`,
    trigger: current.trigger || `Tap “Open ${target?.title ?? "screen"}”`,
  };
}

function applySnapshot(state: AppStudioDashboardState, snapshot: AppStudioDashboardSnapshot) {
  state.appStudioDashboard = snapshot;
  state.appStudioSelectedAppDir = snapshot.selectedProject?.appDir ?? null;
  state.appStudioLastFetchAt = Date.now();
  if (!state.appStudioPromptDraft.trim()) {
    state.appStudioPromptDraft = snapshot.defaultPrompt || DEFAULT_APP_STUDIO_PROMPT;
  }
  state.appStudioAppleFactsDraft = buildAppleFactsDraft(snapshot.selectedProject);
  state.appStudioBuildEngineDraft =
    snapshot.selectedProject?.studio.buildEngine ?? DEFAULT_APP_STUDIO_BUILD_ENGINE;
  state.appStudioFlowDraft = defaultFlowDraft(snapshot.selectedProject, state.appStudioFlowDraft);
  scheduleSnapshotPoll(state, snapshot.selectedProject?.appDir ?? null);
}

async function requestSnapshot(
  state: AppStudioDashboardState,
  appDir?: string | null,
): Promise<AppStudioDashboardSnapshot> {
  if (!state.client || !state.connected) {
    throw new Error("gateway not connected");
  }
  const snapshot = await state.client.request<AppStudioDashboardSnapshot>(
    "apps.dashboard.snapshot",
    appDir ? { appDir } : {},
    { timeoutMs: 60_000 },
  );
  applySnapshot(state, snapshot);
  state.requestUpdate?.();
  return snapshot;
}

async function runAction(
  state: AppStudioDashboardState,
  action: string,
  method: string,
  params: Record<string, unknown>,
  opts?: { timeoutMs?: number; pollAppDir?: string | null },
) {
  if (!state.client || !state.connected || state.appStudioSavingAction) {
    return;
  }
  state.appStudioActionStartedAt = Date.now();
  state.appStudioSavingAction = action;
  state.appStudioError = null;
  state.appStudioActionReceipt = null;
  state.requestUpdate?.();
  const pollAppDir = opts?.pollAppDir ?? (typeof params.appDir === "string" ? params.appDir : null);
  scheduleSnapshotPoll(state, pollAppDir);
  try {
    const result = await state.client.request<AppStudioActionResult>(method, params, {
      timeoutMs: opts?.timeoutMs ?? 180_000,
    });
    applySnapshot(state, result.snapshot);
    state.appStudioActionReceipt = result.receipt;
  } catch (error) {
    state.appStudioError = errorMessage(error);
  } finally {
    state.appStudioSavingAction = null;
    state.appStudioActionStartedAt = null;
    scheduleSnapshotPoll(state, pollAppDir);
    state.requestUpdate?.();
  }
}

export async function loadAppStudioDashboard(
  state: AppStudioDashboardState,
  opts?: { appDir?: string | null; quiet?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (!opts?.quiet) {
    state.appStudioLoading = true;
  }
  state.appStudioError = null;
  state.requestUpdate?.();
  try {
    await requestSnapshot(state, opts?.appDir ?? state.appStudioSelectedAppDir);
  } catch (error) {
    state.appStudioError = errorMessage(error);
  } finally {
    state.appStudioLoading = false;
    state.requestUpdate?.();
  }
}

export async function createAppStudioProject(state: AppStudioDashboardState) {
  const request = state.appStudioPromptDraft.trim();
  if (!request) {
    state.appStudioError = "Describe the app first.";
    state.requestUpdate?.();
    return;
  }
  await runAction(state, "create", "apps.project.create", {
    request,
    appName: state.appStudioCreateNameDraft.trim() || undefined,
    appId: state.appStudioCreateAppIdDraft.trim() || undefined,
    bundleId: state.appStudioCreateBundleIdDraft.trim() || undefined,
    buildEngine: state.appStudioBuildEngineDraft,
  });
}

export async function applyAppStudioPrompt(state: AppStudioDashboardState) {
  const appDir = state.appStudioDashboard?.selectedProject?.appDir;
  const prompt = state.appStudioPromptDraft.trim();
  if (!appDir || !prompt) {
    state.appStudioError = "Select an app and enter a prompt first.";
    state.requestUpdate?.();
    return;
  }
  await runAction(state, "prompt", "apps.project.applyPrompt", { appDir, prompt });
}

export async function setAppStudioBuildEngine(
  state: AppStudioDashboardState,
  buildEngine: AppStudioBuildEngine,
) {
  state.appStudioBuildEngineDraft = buildEngine;
  const appDir = state.appStudioDashboard?.selectedProject?.appDir;
  if (!appDir) {
    state.requestUpdate?.();
    return;
  }
  await runAction(state, "build-engine", "apps.project.setBuildEngine", { appDir, buildEngine });
}

export async function runAppStudioGate(state: AppStudioDashboardState, gate: AppStudioGateId) {
  const appDir = state.appStudioDashboard?.selectedProject?.appDir;
  if (!appDir) {
    state.appStudioError = "Select an app first.";
    state.requestUpdate?.();
    return;
  }
  await runAction(
    state,
    `gate:${gate}`,
    "apps.project.runGate",
    { appDir, gate },
    { timeoutMs: 900_000, pollAppDir: appDir },
  );
}

export async function selectAppStudioProject(state: AppStudioDashboardState, appDir: string) {
  if (!appDir) {
    return;
  }
  state.appStudioSelectedAppDir = appDir;
  await loadAppStudioDashboard(state, { appDir, quiet: false });
}

export async function reorderAppStudioScreens(
  state: AppStudioDashboardState,
  screenId: string,
  direction: "up" | "down",
) {
  const selected = state.appStudioDashboard?.selectedProject;
  if (!selected) {
    return;
  }
  const screenIds = selected.screens.map((screen) => screen.id);
  const index = screenIds.indexOf(screenId);
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= screenIds.length) {
    return;
  }
  const next = [...screenIds];
  const [moved] = next.splice(index, 1);
  next.splice(targetIndex, 0, moved);
  await setAppStudioScreenOrder(state, next);
}

export async function setAppStudioScreenOrder(state: AppStudioDashboardState, screenIds: string[]) {
  const selected = state.appStudioDashboard?.selectedProject;
  if (!selected || screenIds.length === 0) {
    return;
  }
  await runAction(state, "reorder", "apps.project.reorderScreens", {
    appDir: selected.appDir,
    screenIds,
  });
}

async function fileToScreenImageDraft(file: File): Promise<AppStudioScreenImageDraft> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return {
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    dataUrl: `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`,
  };
}

export async function updateAppStudioScreenImageFiles(
  state: AppStudioDashboardState,
  files: FileList | File[] | null,
) {
  const selected = Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));
  state.appStudioScreenImageDrafts = await Promise.all(
    selected.slice(0, 6).map(fileToScreenImageDraft),
  );
  state.requestUpdate?.();
}

export function updateAppStudioScreenImageNotes(state: AppStudioDashboardState, value: string) {
  state.appStudioScreenImageNotesDraft = value;
  state.requestUpdate?.();
}

export function updateAppStudioScreenAnalysisDraft(state: AppStudioDashboardState, value: string) {
  state.appStudioScreenAnalysisDraft = value;
  state.requestUpdate?.();
}

export async function importAppStudioScreenImages(state: AppStudioDashboardState) {
  const appDir = state.appStudioDashboard?.selectedProject?.appDir;
  if (!appDir) {
    state.appStudioError = "Select an app first.";
    state.requestUpdate?.();
    return;
  }
  if (
    state.appStudioScreenImageDrafts.length === 0 &&
    !state.appStudioScreenImageNotesDraft.trim()
  ) {
    state.appStudioError = "Upload a screen picture or add a short screen-flow note first.";
    state.requestUpdate?.();
    return;
  }
  await runAction(state, "screen-images", "apps.project.importScreenImages", {
    appDir,
    notes: state.appStudioScreenImageNotesDraft.trim(),
    images: state.appStudioScreenImageDrafts,
  });
  if (!state.appStudioError) {
    state.appStudioScreenImageDrafts = [];
    state.appStudioScreenImageNotesDraft = "";
  }
}

export async function applyAppStudioScreenAnalysis(state: AppStudioDashboardState) {
  const appDir = state.appStudioDashboard?.selectedProject?.appDir;
  const analysisJson = state.appStudioScreenAnalysisDraft.trim();
  if (!appDir) {
    state.appStudioError = "Select an app first.";
    state.requestUpdate?.();
    return;
  }
  if (!analysisJson) {
    state.appStudioError = "Paste the AI picture analysis JSON first.";
    state.requestUpdate?.();
    return;
  }
  await runAction(state, "screen-analysis", "apps.project.applyScreenAnalysis", {
    appDir,
    analysisJson,
  });
  if (!state.appStudioError) {
    state.appStudioScreenAnalysisDraft = "";
  }
}

export function updateAppStudioFlowDraft(
  state: AppStudioDashboardState,
  field: keyof AppStudioFlowDraft,
  value: string,
) {
  state.appStudioFlowDraft = {
    ...state.appStudioFlowDraft,
    [field]: value,
  };
  state.requestUpdate?.();
}

function flowEdgeId(fromScreenId: string, toScreenId: string): string {
  return `${fromScreenId}-to-${toScreenId}`;
}

export async function addAppStudioScreenFlowConnection(state: AppStudioDashboardState) {
  const selected = state.appStudioDashboard?.selectedProject;
  if (!selected) {
    state.appStudioError = "Select an app first.";
    state.requestUpdate?.();
    return;
  }
  const draft = defaultFlowDraft(selected, state.appStudioFlowDraft);
  if (!draft.fromScreenId || !draft.toScreenId || draft.fromScreenId === draft.toScreenId) {
    state.appStudioError = "Choose two different screens for the connection.";
    state.requestUpdate?.();
    return;
  }
  const target = selected.screens.find((screen) => screen.id === draft.toScreenId);
  const edge = {
    id: flowEdgeId(draft.fromScreenId, draft.toScreenId),
    fromScreenId: draft.fromScreenId,
    toScreenId: draft.toScreenId,
    label: draft.label.trim() || `Open ${target?.title ?? "screen"}`,
    trigger: draft.trigger.trim() || `Tap “Open ${target?.title ?? "screen"}”`,
  };
  const nextEdges = [
    ...selected.screenFlow.edges.filter(
      (item) => item.fromScreenId !== edge.fromScreenId || item.toScreenId !== edge.toScreenId,
    ),
    edge,
  ];
  await runAction(state, "screen-flow", "apps.project.updateScreenFlow", {
    appDir: selected.appDir,
    screenFlow: {
      entryScreenId: selected.screenFlow.entryScreenId || selected.screens[0]?.id,
      edges: nextEdges,
    },
  });
}

export async function removeAppStudioScreenFlowConnection(
  state: AppStudioDashboardState,
  edgeId: string,
) {
  const selected = state.appStudioDashboard?.selectedProject;
  if (!selected) {
    return;
  }
  await runAction(state, "screen-flow", "apps.project.updateScreenFlow", {
    appDir: selected.appDir,
    screenFlow: {
      entryScreenId: selected.screenFlow.entryScreenId || selected.screens[0]?.id,
      edges: selected.screenFlow.edges.filter((edge) => edge.id !== edgeId),
    },
  });
}

export function updateAppStudioAppleFact(
  state: AppStudioDashboardState,
  field: keyof AppStudioAppleFactsDraft,
  value: string,
) {
  state.appStudioAppleFactsDraft = {
    ...state.appStudioAppleFactsDraft,
    [field]: value,
  };
  state.requestUpdate?.();
}

export async function importAppStudioAppleFacts(state: AppStudioDashboardState) {
  const appDir = state.appStudioDashboard?.selectedProject?.appDir;
  if (!appDir) {
    state.appStudioError = "Select an app first.";
    state.requestUpdate?.();
    return;
  }
  await runAction(state, "apple-facts", "apps.project.importAppleFacts", {
    appDir,
    ...state.appStudioAppleFactsDraft,
  });
}

export async function approveAppStudioGate(state: AppStudioDashboardState, approvalId: string) {
  const appDir = state.appStudioDashboard?.selectedProject?.appDir;
  if (!appDir) {
    state.appStudioError = "Select an app first.";
    state.requestUpdate?.();
    return;
  }
  await runAction(state, `approval:${approvalId}`, "apps.project.approveGate", {
    appDir,
    approvalId,
  });
}

export function dismissAppStudioReceipt(state: AppStudioDashboardState) {
  state.appStudioActionReceipt = null;
  state.requestUpdate?.();
}
