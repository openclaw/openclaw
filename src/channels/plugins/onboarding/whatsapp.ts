import fs from "node:fs/promises";
import path from "node:path";
import { loginWeb } from "../../../channel-web.js";
import type { ClawdbotConfig } from "../../../config/config.js";
import { mergeWhatsAppConfig, upsertSkillEntry } from "../../../config/merge-config.js";
import type { DmPolicy } from "../../../config/types.js";
import type {
  VoiceNotesTranscriptionConfig,
  VideoUnderstandingConfig,
} from "../../../config/types.messages.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateGroqApiKey,
  validateGeminiApiKey,
} from "../../../commands/auth-choice.api-key.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { formatDocsLink } from "../../../terminal/links.js";
import { normalizeE164 } from "../../../utils.js";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAuthDir,
} from "../../../web/accounts.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter } from "../onboarding-types.js";
import { promptAccountId } from "./helpers.js";

const channel = "whatsapp" as const;

function setWhatsAppDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy): ClawdbotConfig {
  return mergeWhatsAppConfig(cfg, { dmPolicy });
}

function setWhatsAppAllowFrom(cfg: ClawdbotConfig, allowFrom?: string[]): ClawdbotConfig {
  return mergeWhatsAppConfig(cfg, { allowFrom }, { unsetOnUndefined: ["allowFrom"] });
}

function setMessagesResponsePrefix(cfg: ClawdbotConfig, responsePrefix?: string): ClawdbotConfig {
  return {
    ...cfg,
    messages: {
      ...cfg.messages,
      responsePrefix,
    },
  };
}

function setWhatsAppSelfChatMode(cfg: ClawdbotConfig, selfChatMode: boolean): ClawdbotConfig {
  return mergeWhatsAppConfig(cfg, { selfChatMode });
}

function setVoiceTranscription(
  cfg: ClawdbotConfig,
  patch: Partial<VoiceNotesTranscriptionConfig>,
): ClawdbotConfig {
  return {
    ...cfg,
    voiceNotes: {
      ...cfg.voiceNotes,
      transcription: {
        ...cfg.voiceNotes?.transcription,
        ...patch,
      },
    },
  };
}

function setVideoUnderstanding(
  cfg: ClawdbotConfig,
  patch: Partial<VideoUnderstandingConfig>,
): ClawdbotConfig {
  return {
    ...cfg,
    video: {
      ...cfg.video,
      understanding: {
        ...cfg.video?.understanding,
        ...patch,
      },
    },
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectWhatsAppLinked(cfg: ClawdbotConfig, accountId: string): Promise<boolean> {
  const { authDir } = resolveWhatsAppAuthDir({ cfg, accountId });
  const credsPath = path.join(authDir, "creds.json");
  return await pathExists(credsPath);
}

async function promptWhatsAppAllowFrom(
  cfg: ClawdbotConfig,
  _runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options?: { forceAllowlist?: boolean },
): Promise<ClawdbotConfig> {
  const existingPolicy = cfg.channels?.whatsapp?.dmPolicy ?? "pairing";
  const existingAllowFrom = cfg.channels?.whatsapp?.allowFrom ?? [];
  const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";
  const existingResponsePrefix = cfg.messages?.responsePrefix;

  if (options?.forceAllowlist) {
    await prompter.note(
      "We need the sender/owner number so Clawdbot can allowlist you.",
      "WhatsApp number",
    );
    const entry = await prompter.text({
      message: "Your personal WhatsApp number (the phone you will message from)",
      placeholder: "+15555550123",
      initialValue: existingAllowFrom[0],
      validate: (value) => {
        const raw = String(value ?? "").trim();
        if (!raw) return "Required";
        const normalized = normalizeE164(raw);
        if (!normalized) return `Invalid number: ${raw}`;
        return undefined;
      },
    });
    const normalized = normalizeE164(String(entry).trim());
    const merged = [
      ...existingAllowFrom
        .filter((item) => item !== "*")
        .map((item) => normalizeE164(item))
        .filter(Boolean),
      normalized,
    ];
    const unique = [...new Set(merged.filter(Boolean))];
    let next = setWhatsAppSelfChatMode(cfg, true);
    next = setWhatsAppDmPolicy(next, "allowlist");
    next = setWhatsAppAllowFrom(next, unique);
    if (existingResponsePrefix === undefined) {
      next = setMessagesResponsePrefix(next, "[clawdbot]");
    }
    await prompter.note(
      [
        "Allowlist mode enabled.",
        `- allowFrom includes ${normalized}`,
        existingResponsePrefix === undefined
          ? "- responsePrefix set to [clawdbot]"
          : "- responsePrefix left unchanged",
      ].join("\n"),
      "WhatsApp allowlist",
    );
    return next;
  }

  await prompter.note(
    [
      "WhatsApp direct chats are gated by `channels.whatsapp.dmPolicy` + `channels.whatsapp.allowFrom`.",
      "- pairing (default): unknown senders get a pairing code; owner approves",
      "- allowlist: unknown senders are blocked",
      '- open: public inbound DMs (requires allowFrom to include "*")',
      "- disabled: ignore WhatsApp DMs",
      "",
      `Current: dmPolicy=${existingPolicy}, allowFrom=${existingLabel}`,
      `Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`,
    ].join("\n"),
    "WhatsApp DM access",
  );

  const phoneMode = (await prompter.select({
    message: "WhatsApp phone setup",
    options: [
      { value: "personal", label: "This is my personal phone number" },
      { value: "separate", label: "Separate phone just for Clawdbot" },
    ],
  })) as "personal" | "separate";

  if (phoneMode === "personal") {
    await prompter.note(
      "We need the sender/owner number so Clawdbot can allowlist you.",
      "WhatsApp number",
    );
    const entry = await prompter.text({
      message: "Your personal WhatsApp number (the phone you will message from)",
      placeholder: "+15555550123",
      initialValue: existingAllowFrom[0],
      validate: (value) => {
        const raw = String(value ?? "").trim();
        if (!raw) return "Required";
        const normalized = normalizeE164(raw);
        if (!normalized) return `Invalid number: ${raw}`;
        return undefined;
      },
    });
    const normalized = normalizeE164(String(entry).trim());
    const merged = [
      ...existingAllowFrom
        .filter((item) => item !== "*")
        .map((item) => normalizeE164(item))
        .filter(Boolean),
      normalized,
    ];
    const unique = [...new Set(merged.filter(Boolean))];
    let next = setWhatsAppSelfChatMode(cfg, true);
    next = setWhatsAppDmPolicy(next, "allowlist");
    next = setWhatsAppAllowFrom(next, unique);
    if (existingResponsePrefix === undefined) {
      next = setMessagesResponsePrefix(next, "[clawdbot]");
    }
    await prompter.note(
      [
        "Personal phone mode enabled.",
        "- dmPolicy set to allowlist (pairing skipped)",
        `- allowFrom includes ${normalized}`,
        existingResponsePrefix === undefined
          ? "- responsePrefix set to [clawdbot]"
          : "- responsePrefix left unchanged",
      ].join("\n"),
      "WhatsApp personal phone",
    );
    return next;
  }

  const policy = (await prompter.select({
    message: "WhatsApp DM policy",
    options: [
      { value: "pairing", label: "Pairing (recommended)" },
      { value: "allowlist", label: "Allowlist only (block unknown senders)" },
      { value: "open", label: "Open (public inbound DMs)" },
      { value: "disabled", label: "Disabled (ignore WhatsApp DMs)" },
    ],
  })) as DmPolicy;

  let next = setWhatsAppSelfChatMode(cfg, false);
  next = setWhatsAppDmPolicy(next, policy);
  if (policy === "open") {
    next = setWhatsAppAllowFrom(next, ["*"]);
  }
  if (policy === "disabled") return next;

  const allowOptions =
    existingAllowFrom.length > 0
      ? ([
          { value: "keep", label: "Keep current allowFrom" },
          {
            value: "unset",
            label: "Unset allowFrom (use pairing approvals only)",
          },
          { value: "list", label: "Set allowFrom to specific numbers" },
        ] as const)
      : ([
          { value: "unset", label: "Unset allowFrom (default)" },
          { value: "list", label: "Set allowFrom to specific numbers" },
        ] as const);

  const mode = (await prompter.select({
    message: "WhatsApp allowFrom (optional pre-allowlist)",
    options: allowOptions.map((opt) => ({
      value: opt.value,
      label: opt.label,
    })),
  })) as (typeof allowOptions)[number]["value"];

  if (mode === "keep") {
    // Keep allowFrom as-is.
  } else if (mode === "unset") {
    next = setWhatsAppAllowFrom(next, undefined);
  } else {
    const allowRaw = await prompter.text({
      message: "Allowed sender numbers (comma-separated, E.164)",
      placeholder: "+15555550123, +447700900123",
      validate: (value) => {
        const raw = String(value ?? "").trim();
        if (!raw) return "Required";
        const parts = raw
          .split(/[\n,;]+/g)
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.length === 0) return "Required";
        for (const part of parts) {
          if (part === "*") continue;
          const normalized = normalizeE164(part);
          if (!normalized) return `Invalid number: ${part}`;
        }
        return undefined;
      },
    });

    const parts = String(allowRaw)
      .split(/[\n,;]+/g)
      .map((p) => p.trim())
      .filter(Boolean);
    const normalized = parts.map((part) => (part === "*" ? "*" : normalizeE164(part)));
    const unique = [...new Set(normalized.filter(Boolean))];
    next = setWhatsAppAllowFrom(next, unique);
  }

  return next;
}

async function promptVoiceTranscription(
  cfg: ClawdbotConfig,
  prompter: WizardPrompter,
): Promise<ClawdbotConfig> {
  // Opt-in confirmation
  const shouldEnable = await prompter.confirm({
    message: "Enable voice note transcription?",
    initialValue: false,
  });

  if (!shouldEnable) {
    await prompter.note(
      [
        "You can configure voice transcription later via `clawdbot configure`",
        "Or ask the agent to enable it: /config set voiceNotes.transcription.enabled=true",
      ].join("\n"),
      "Voice transcription",
    );
    return cfg;
  }

  // Show setup info
  await prompter.note(
    [
      "Voice transcription requires a Groq API key.",
      "Get one free: https://console.groq.com/keys",
      "",
      "Supports: Whisper Large V3 (fast, accurate)",
    ].join("\n"),
    "Groq Setup",
  );

  let apiKey: string | undefined;

  // Check existing config first
  const existingGroqKey = cfg.skills?.entries?.groq?.apiKey;
  if (existingGroqKey && typeof existingGroqKey === "string") {
    const keep = await prompter.confirm({
      message: `Groq API key already configured. Keep it (${formatApiKeyPreview(existingGroqKey)})?`,
      initialValue: true,
    });
    if (keep) {
      apiKey = existingGroqKey;
    }
  }

  // Check env var
  if (!apiKey) {
    const envKey = process.env.GROQ_API_KEY?.trim();
    if (envKey) {
      const useEnv = await prompter.confirm({
        message: `GROQ_API_KEY detected. Use env var (${formatApiKeyPreview(envKey)})?`,
        initialValue: true,
      });
      if (useEnv) {
        apiKey = envKey;
      }
    }
  }

  // Prompt for new key
  if (!apiKey) {
    const key = await prompter.text({
      message: "Enter Groq API key",
      placeholder: "gsk_...",
      validate: validateGroqApiKey,
    });
    apiKey = normalizeApiKeyInput(String(key ?? ""));
  }

  // Store API key
  let next = upsertSkillEntry(cfg, "groq", { apiKey });

  // Chat scope selection
  const chatScope = (await prompter.select({
    message: "Enable voice transcription for:",
    options: [
      { label: "DMs only", value: "dm-only" },
      { label: "DMs and all groups", value: "dm-and-groups" },
    ],
  })) as "dm-only" | "dm-and-groups";

  const groupEnabled = chatScope === "dm-and-groups";

  // Build config (avoid undefined properties)
  const transcriptionConfig: Partial<VoiceNotesTranscriptionConfig> = {
    enabled: true,
    provider: "groq",
    dmEnabled: true,
    groupEnabled,
  };

  if (groupEnabled) {
    transcriptionConfig.groupAllowFrom = ["*"];
  }

  next = setVoiceTranscription(next, transcriptionConfig);

  return next;
}

async function promptVideoUnderstanding(
  cfg: ClawdbotConfig,
  prompter: WizardPrompter,
): Promise<ClawdbotConfig> {
  // Opt-in confirmation
  const shouldEnable = await prompter.confirm({
    message: "Enable video understanding?",
    initialValue: false,
  });

  if (!shouldEnable) {
    await prompter.note(
      [
        "You can configure video understanding later via `clawdbot configure`",
        "Or ask the agent to enable it: /config set video.understanding.enabled=true",
      ].join("\n"),
      "Video understanding",
    );
    return cfg;
  }

  // Show setup info
  await prompter.note(
    [
      "Video understanding requires a Google Gemini API key.",
      "Get one: https://ai.google.dev/gemini-api/docs/api-key",
      "",
      "Supports: Gemini 3 Flash (video analysis)",
    ].join("\n"),
    "Gemini Setup",
  );

  let apiKey: string | undefined;

  // Check existing config first
  const existingGeminiKey = cfg.skills?.entries?.gemini?.apiKey;
  if (existingGeminiKey && typeof existingGeminiKey === "string") {
    const keep = await prompter.confirm({
      message: `Gemini API key already configured. Keep it (${formatApiKeyPreview(existingGeminiKey)})?`,
      initialValue: true,
    });
    if (keep) {
      apiKey = existingGeminiKey;
    }
  }

  // Check env var
  if (!apiKey) {
    const envKey = process.env.GEMINI_API_KEY?.trim();
    if (envKey) {
      const useEnv = await prompter.confirm({
        message: `GEMINI_API_KEY detected. Use env var (${formatApiKeyPreview(envKey)})?`,
        initialValue: true,
      });
      if (useEnv) {
        apiKey = envKey;
      }
    }
  }

  // Prompt for new key
  if (!apiKey) {
    const key = await prompter.text({
      message: "Enter Gemini API key",
      placeholder: "AIza...",
      validate: validateGeminiApiKey,
    });
    apiKey = normalizeApiKeyInput(String(key ?? ""));
  }

  // Store API key
  let next = upsertSkillEntry(cfg, "gemini", { apiKey });

  // Chat scope selection
  const chatScope = (await prompter.select({
    message: "Enable video understanding for:",
    options: [
      { label: "DMs only", value: "dm-only" },
      { label: "DMs and all groups", value: "dm-and-groups" },
    ],
  })) as "dm-only" | "dm-and-groups";

  const groupEnabled = chatScope === "dm-and-groups";

  // Build config (avoid undefined properties)
  const understandingConfig: Partial<VideoUnderstandingConfig> = {
    enabled: true,
    provider: "gemini",
    dmEnabled: true,
    groupEnabled,
  };

  if (groupEnabled) {
    understandingConfig.groupAllowFrom = ["*"];
  }

  next = setVideoUnderstanding(next, understandingConfig);

  return next;
}

export const whatsappOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg, accountOverrides }) => {
    const overrideId = accountOverrides.whatsapp?.trim();
    const defaultAccountId = resolveDefaultWhatsAppAccountId(cfg);
    const accountId = overrideId ? normalizeAccountId(overrideId) : defaultAccountId;
    const linked = await detectWhatsAppLinked(cfg, accountId);
    const accountLabel = accountId === DEFAULT_ACCOUNT_ID ? "default" : accountId;
    return {
      channel,
      configured: linked,
      statusLines: [`WhatsApp (${accountLabel}): ${linked ? "linked" : "not linked"}`],
      selectionHint: linked ? "linked" : "not linked",
      quickstartScore: linked ? 5 : 4,
    };
  },
  configure: async ({
    cfg,
    runtime,
    prompter,
    options,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const overrideId = accountOverrides.whatsapp?.trim();
    let accountId = overrideId
      ? normalizeAccountId(overrideId)
      : resolveDefaultWhatsAppAccountId(cfg);
    if (shouldPromptAccountIds || options?.promptWhatsAppAccountId) {
      if (!overrideId) {
        accountId = await promptAccountId({
          cfg,
          prompter,
          label: "WhatsApp",
          currentId: accountId,
          listAccountIds: listWhatsAppAccountIds,
          defaultAccountId: resolveDefaultWhatsAppAccountId(cfg),
        });
      }
    }

    let next = cfg;
    if (accountId !== DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          whatsapp: {
            ...next.channels?.whatsapp,
            accounts: {
              ...next.channels?.whatsapp?.accounts,
              [accountId]: {
                ...next.channels?.whatsapp?.accounts?.[accountId],
                enabled: next.channels?.whatsapp?.accounts?.[accountId]?.enabled ?? true,
              },
            },
          },
        },
      };
    }

    const linked = await detectWhatsAppLinked(next, accountId);
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: next,
      accountId,
    });

    if (!linked) {
      await prompter.note(
        [
          "Scan the QR with WhatsApp on your phone.",
          `Credentials are stored under ${authDir}/ for future runs.`,
          `Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`,
        ].join("\n"),
        "WhatsApp linking",
      );
    }
    const wantsLink = await prompter.confirm({
      message: linked ? "WhatsApp already linked. Re-link now?" : "Link WhatsApp now (QR)?",
      initialValue: !linked,
    });
    if (wantsLink) {
      try {
        await loginWeb(false, undefined, runtime, accountId);
      } catch (err) {
        runtime.error(`WhatsApp login failed: ${String(err)}`);
        await prompter.note(`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`, "WhatsApp help");
      }
    } else if (!linked) {
      await prompter.note("Run `clawdbot channels login` later to link WhatsApp.", "WhatsApp");
    }

    next = await promptWhatsAppAllowFrom(next, runtime, prompter, {
      forceAllowlist: forceAllowFrom,
    });

    // Media features (voice + video)
    next = await promptVoiceTranscription(next, prompter);
    next = await promptVideoUnderstanding(next, prompter);

    return { cfg: next, accountId };
  },
  onAccountRecorded: (accountId, options) => {
    options?.onWhatsAppAccountId?.(accountId);
  },
};
