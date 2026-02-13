import { isCancel, select as clackSelect } from "@clack/prompts";
import type { RuntimeEnv } from "../../runtime.js";
import { stylePromptHint, stylePromptMessage } from "../../terminal/prompt-style.js";
import {
  getAuthSwitchContext,
  getSwitchableProfiles,
  performAuthSwitch,
} from "./auth-switch.logic.js";

export async function modelsAuthSwitchCommand(
  opts: {
    provider: string;
    profile?: string;
    agent?: string;
  },
  runtime: RuntimeEnv,
) {
  const ctx = getAuthSwitchContext({ provider: opts.provider, agent: opts.agent });
  const { profileIds, displayInfos } = getSwitchableProfiles(ctx);

  if (profileIds.length === 0) {
    throw new Error(`No auth profiles found for provider "${ctx.provider}".`);
  }

  let selectedProfileId: string;

  if (opts.profile) {
    // Non-interactive mode
    selectedProfileId = opts.profile.trim();
    // Logic will validate existence
  } else {
    // Interactive mode — use clack select
    const displayMap = new Map(displayInfos.map((info) => [info.profileId, info]));
    const options = profileIds.map((profileId) => {
      const info = displayMap.get(profileId);
      const parts: string[] = [];
      if (info) {
        parts.push(info.type);
        parts.push(info.status);
        if (info.email) {
          parts.push(info.email);
        }
      }
      const hint = parts.length > 0 ? parts.join(" · ") : undefined;
      return {
        value: profileId,
        label: profileId,
        hint,
      };
    });

    const result = await clackSelect({
      message: stylePromptMessage(`Select active auth profile for ${ctx.provider}`),
      options: options.map((opt) =>
        opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
      ),
    });

    if (isCancel(result)) {
      runtime.log("Cancelled.");
      return;
    }

    selectedProfileId = String(result);
  }

  await performAuthSwitch(ctx, selectedProfileId);

  const displayMap = new Map(displayInfos.map((info) => [info.profileId, info]));
  const info = displayMap.get(selectedProfileId);
  const detail = info ? ` (${info.type}${info.email ? `, ${info.email}` : ""})` : "";
  runtime.log(`Switched ${ctx.provider} active profile to ${selectedProfileId}${detail}`);
}
