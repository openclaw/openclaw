import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { formatDocsLink } from "../../../terminal/links.js";
import { normalizeE164 } from "../../../utils.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { addWildcardAllowFrom, mergeAllowFromEntries } from "./helpers.js";

const channel = "wati" as const;

function setWatiDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.wati?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      wati: {
        ...cfg.channels?.wati,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

async function promptWatiAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;
  const existingAllowFrom: string[] = cfg.channels?.wati?.allowFrom ?? [];

  const entry = await prompter.text({
    message: "WATI allowFrom (phone numbers, comma-separated, E.164)",
    placeholder: "+15555550123",
    initialValue: existingAllowFrom[0] ?? undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      const parts = raw
        .split(/[\n,;]+/g)
        .map((p) => p.trim())
        .filter(Boolean);
      for (const part of parts) {
        if (part === "*") {
          continue;
        }
        if (!normalizeE164(part)) {
          return `Invalid number: ${part}`;
        }
      }
      return undefined;
    },
  });

  const parts = String(entry)
    .split(/[\n,;]+/g)
    .map((p) => p.trim())
    .filter(Boolean);
  const normalized = parts
    .map((p) => (p === "*" ? "*" : normalizeE164(p)))
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  const unique = mergeAllowFromEntries(existingAllowFrom, normalized);

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      wati: {
        ...cfg.channels?.wati,
        enabled: true,
        dmPolicy: "allowlist",
        allowFrom: unique,
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "WATI",
  channel,
  policyKey: "channels.wati.dmPolicy",
  allowFromKey: "channels.wati.allowFrom",
  getCurrent: (cfg) => cfg.channels?.wati?.dmPolicy ?? "open",
  setPolicy: (cfg, policy) => setWatiDmPolicy(cfg, policy),
  promptAllowFrom: promptWatiAllowFrom,
};

export const watiOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const hasToken = Boolean(cfg.channels?.wati?.apiToken || process.env.WATI_API_TOKEN?.trim());
    return {
      channel,
      configured: hasToken,
      statusLines: [`WATI: ${hasToken ? "configured" : "needs API token"}`],
      selectionHint: hasToken ? "configured" : "requires WATI account",
      quickstartScore: hasToken ? 2 : 8,
    };
  },
  configure: async ({ cfg, prompter }) => {
    let next = cfg;

    const existingToken = next.channels?.wati?.apiToken;
    const envToken = process.env.WATI_API_TOKEN?.trim();

    let token: string | null = null;
    if (envToken && !existingToken) {
      const keepEnv = await prompter.confirm({
        message: "WATI_API_TOKEN detected in env. Use it?",
        initialValue: true,
      });
      if (!keepEnv) {
        token = String(
          await prompter.text({
            message: "Enter WATI API token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (existingToken) {
      const keep = await prompter.confirm({
        message: "WATI API token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: "Enter WATI API token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      await prompter.note(
        [
          "1) Log in to your WATI dashboard",
          "2) Go to API Docs → Bearer Token",
          "3) Copy the token",
          "Tip: you can also set WATI_API_TOKEN in your env.",
          `Docs: ${formatDocsLink("/wati")}`,
        ].join("\n"),
        "WATI API token",
      );
      token = String(
        await prompter.text({
          message: "Enter WATI API token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    next = {
      ...next,
      channels: {
        ...next.channels,
        wati: {
          ...next.channels?.wati,
          enabled: true,
          ...(token ? { apiToken: token } : {}),
        },
      },
    };

    // Optionally prompt for tenant ID
    const existingTenantId = next.channels?.wati?.tenantId;
    const envTenantId = process.env.WATI_TENANT_ID?.trim();
    if (!existingTenantId && !envTenantId) {
      const wantsTenant = await prompter.confirm({
        message: "Configure WATI tenant ID? (optional)",
        initialValue: false,
      });
      if (wantsTenant) {
        const tenantId = String(
          await prompter.text({
            message: "Enter WATI tenant ID",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        next = {
          ...next,
          channels: {
            ...next.channels,
            wati: {
              ...next.channels?.wati,
              tenantId,
            },
          },
        };
      }
    }

    // Optionally prompt for webhook URL
    const existingWebhookUrl = next.channels?.wati?.webhookUrl;
    if (!existingWebhookUrl) {
      const wantsWebhook = await prompter.confirm({
        message: "Configure webhook URL? (needed for inbound messages)",
        initialValue: false,
      });
      if (wantsWebhook) {
        const webhookUrl = String(
          await prompter.text({
            message: "Public webhook URL for WATI callbacks",
            placeholder: "https://your-server.com/webhook/wati",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        next = {
          ...next,
          channels: {
            ...next.channels,
            wati: {
              ...next.channels?.wati,
              webhookUrl,
            },
          },
        };
      }
    }

    return { cfg: next };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      wati: { ...cfg.channels?.wati, enabled: false },
    },
  }),
};
