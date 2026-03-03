import type { GatewayBrowserClient } from "../gateway.ts";
import type { SkillStatusReport } from "../types.ts";

export type SkillsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  skillsLoading: boolean;
  skillsReport: SkillStatusReport | null;
  skillsError: string | null;
  skillsBusyKey: string | null;
  skillEdits: Record<string, string>;
  skillMessages: SkillMessageMap;
};

export type SkillMessage = {
  kind: "success" | "error";
  message: string;
};

export type SkillMessageMap = Record<string, SkillMessage>;

export type SkillClassificationType = "default" | "optional";

type SkillTypeUpdateResult = {
  defaultSkills?: string[];
  type?: SkillClassificationType;
};

type LoadSkillsOptions = {
  clearMessages?: boolean;
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

function applySkillTypeUpdate(
  state: SkillsState,
  params: { skillKey: string; skillName: string; type: SkillClassificationType },
  result?: SkillTypeUpdateResult,
) {
  const report = state.skillsReport;
  if (!report) {
    return;
  }
  const defaultSkills = Array.isArray(result?.defaultSkills)
    ? new Set(result.defaultSkills.map((name) => String(name).trim()).filter(Boolean))
    : null;
  const normalizedSkillName = params.skillName.trim();
  const requestedType = result?.type ?? params.type;
  const updatedSkills = report.skills.map((skill) => {
    const isTargetSkill =
      skill.skillKey === params.skillKey ||
      (normalizedSkillName.length > 0 && skill.name === normalizedSkillName);
    if (defaultSkills) {
      return {
        ...skill,
        type: defaultSkills.has(skill.name) ? "default" : "optional",
      };
    }
    if (!isTargetSkill) {
      return skill;
    }
    return {
      ...skill,
      type: requestedType,
    };
  });
  state.skillsReport = {
    ...report,
    ...(defaultSkills ? { defaultSkills: [...defaultSkills] } : {}),
    skills: updatedSkills,
  };
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

export async function updateSkillType(
  state: SkillsState,
  params: { skillKey: string; skillName: string; type: SkillClassificationType },
) {
  if (!state.client || !state.connected) {
    return;
  }
  state.skillsBusyKey = params.skillKey;
  state.skillsError = null;
  try {
    const result = await state.client.request<SkillTypeUpdateResult>("skills.update", {
      skillKey: params.skillKey,
      skillName: params.skillName,
      type: params.type,
    });
    applySkillTypeUpdate(state, params, result);
    setSkillMessage(state, params.skillKey, {
      kind: "success",
      message: params.type === "default" ? "Added to default skills" : "Marked as optional",
    });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, params.skillKey, {
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
