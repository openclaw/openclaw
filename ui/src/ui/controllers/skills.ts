import type { GatewayBrowserClient } from "../gateway.ts";
import type { SkillSecurityVerdict, SkillStatusReport } from "../types.ts";

export type SkillsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  skillsLoading: boolean;
  skillsReport: SkillStatusReport | null;
  skillsError: string | null;
  skillsBusyKey: string | null;
  skillEdits: Record<string, string>;
  skillMessages: SkillMessageMap;
  skillVerdicts: Record<string, SkillSecurityVerdict>;
  skillVerdictErrors: Record<string, string>;
  skillVerdictExpanded: Record<string, boolean>;
  skillVerdictLoadingKey: string | null;
};

export type SkillMessage = {
  kind: "success" | "error";
  message: string;
};

export type SkillMessageMap = Record<string, SkillMessage>;

type LoadSkillsOptions = {
  clearMessages?: boolean;
};

type LoadSkillVerdictOptions = {
  force?: boolean;
};

function setSkillMessage(state: SkillsState, key: string, message?: SkillMessage) {
  if (!key.trim()) {
    return;
  }
  const next = { ...state.skillMessages };
  if (message) {
    next[key] = message;
  } else {
    delete next[key];
  }
  state.skillMessages = next;
}

function getErrorMessage(err: unknown) {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function filterRecordByKeys<T>(record: Record<string, T>, keys: Set<string>): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key)) {
      next[key] = value;
    }
  }
  return next;
}

function pruneSkillVerdictState(state: SkillsState, report: SkillStatusReport) {
  const keys = new Set(report.skills.map((skill) => skill.skillKey));
  state.skillVerdicts = filterRecordByKeys(state.skillVerdicts, keys);
  state.skillVerdictErrors = filterRecordByKeys(state.skillVerdictErrors, keys);
  state.skillVerdictExpanded = filterRecordByKeys(state.skillVerdictExpanded, keys);
  if (state.skillVerdictLoadingKey && !keys.has(state.skillVerdictLoadingKey)) {
    state.skillVerdictLoadingKey = null;
  }
}

export async function loadSkills(state: SkillsState, options?: LoadSkillsOptions) {
  if (options?.clearMessages && Object.keys(state.skillMessages).length > 0) {
    state.skillMessages = {};
  }
  if (!state.client || !state.connected) {
    return;
  }
  if (state.skillsLoading) {
    return;
  }
  state.skillsLoading = true;
  state.skillsError = null;
  try {
    const res = await state.client.request<SkillStatusReport | undefined>("skills.status", {});
    if (res) {
      state.skillsReport = res;
      pruneSkillVerdictState(state, res);
    }
  } catch (err) {
    state.skillsError = getErrorMessage(err);
  } finally {
    state.skillsLoading = false;
  }
}

export function updateSkillEdit(state: SkillsState, skillKey: string, value: string) {
  state.skillEdits = { ...state.skillEdits, [skillKey]: value };
}

export async function loadSkillVerdict(
  state: SkillsState,
  skillKey: string,
  options?: LoadSkillVerdictOptions,
) {
  if (!state.client || !state.connected) {
    return;
  }
  const key = skillKey.trim();
  if (!key) {
    return;
  }
  if (!options?.force && state.skillVerdicts[key]) {
    return;
  }
  if (state.skillVerdictLoadingKey === key) {
    return;
  }

  state.skillVerdictLoadingKey = key;
  const nextErrors = { ...state.skillVerdictErrors };
  delete nextErrors[key];
  state.skillVerdictErrors = nextErrors;
  try {
    const verdict = await state.client.request<SkillSecurityVerdict | undefined>("skills.verdict", {
      skillKey: key,
    });
    if (verdict) {
      state.skillVerdicts = { ...state.skillVerdicts, [key]: verdict };
    }
  } catch (err) {
    state.skillVerdictErrors = {
      ...state.skillVerdictErrors,
      [key]: getErrorMessage(err),
    };
  } finally {
    if (state.skillVerdictLoadingKey === key) {
      state.skillVerdictLoadingKey = null;
    }
  }
}

export function toggleSkillVerdictPanel(state: SkillsState, skillKey: string) {
  const key = skillKey.trim();
  if (!key) {
    return;
  }
  const currentlyExpanded = Boolean(state.skillVerdictExpanded[key]);
  state.skillVerdictExpanded = { ...state.skillVerdictExpanded, [key]: !currentlyExpanded };
  if (!currentlyExpanded) {
    void loadSkillVerdict(state, key);
  }
}

export async function updateSkillEnabled(state: SkillsState, skillKey: string, enabled: boolean) {
  if (!state.client || !state.connected) {
    return;
  }
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    await state.client.request("skills.update", { skillKey, enabled });
    await loadSkills(state);
    setSkillMessage(state, skillKey, {
      kind: "success",
      message: enabled ? "Skill enabled" : "Skill disabled",
    });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function saveSkillApiKey(state: SkillsState, skillKey: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    const apiKey = state.skillEdits[skillKey] ?? "";
    await state.client.request("skills.update", { skillKey, apiKey });
    await loadSkills(state);
    setSkillMessage(state, skillKey, {
      kind: "success",
      message: "API key saved",
    });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function installSkill(
  state: SkillsState,
  skillKey: string,
  name: string,
  installId: string,
) {
  if (!state.client || !state.connected) {
    return;
  }
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    const result = await state.client.request<{ message?: string }>("skills.install", {
      name,
      installId,
      timeoutMs: 120000,
    });
    await loadSkills(state);
    setSkillMessage(state, skillKey, {
      kind: "success",
      message: result?.message ?? "Installed",
    });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}
