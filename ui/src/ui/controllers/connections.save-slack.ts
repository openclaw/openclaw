import { parseList } from "../format";
import { defaultSlackActions, type SlackActionForm } from "../ui-types";
import type { ConnectionsState } from "./connections.types";

export async function saveSlackConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.slackSaving) return;
  state.slackSaving = true;
  state.slackConfigStatus = null;
  try {
    const base = state.configSnapshot?.config ?? {};
    const config = { ...base } as Record<string, unknown>;
    const slack = { ...(config.slack ?? {}) } as Record<string, unknown>;
    const form = state.slackForm;

    if (form.enabled) {
      delete slack.enabled;
    } else {
      slack.enabled = false;
    }

    if (!state.slackTokenLocked) {
      const token = form.botToken.trim();
      if (token) slack.botToken = token;
      else delete slack.botToken;
    }
    if (!state.slackAppTokenLocked) {
      const token = form.appToken.trim();
      if (token) slack.appToken = token;
      else delete slack.appToken;
    }

    const dm = { ...(slack.dm ?? {}) } as Record<string, unknown>;
    dm.enabled = form.dmEnabled;
    const allowFrom = parseList(form.allowFrom);
    if (allowFrom.length > 0) dm.allowFrom = allowFrom;
    else delete dm.allowFrom;
    if (form.groupEnabled) {
      dm.groupEnabled = true;
    } else {
      delete dm.groupEnabled;
    }
    const groupChannels = parseList(form.groupChannels);
    if (groupChannels.length > 0) dm.groupChannels = groupChannels;
    else delete dm.groupChannels;
    if (Object.keys(dm).length > 0) slack.dm = dm;
    else delete slack.dm;

    const mediaMaxMb = Number.parseFloat(form.mediaMaxMb);
    if (Number.isFinite(mediaMaxMb) && mediaMaxMb > 0) {
      slack.mediaMaxMb = mediaMaxMb;
    } else {
      delete slack.mediaMaxMb;
    }

    const textChunkLimit = Number.parseInt(form.textChunkLimit, 10);
    if (Number.isFinite(textChunkLimit) && textChunkLimit > 0) {
      slack.textChunkLimit = textChunkLimit;
    } else {
      delete slack.textChunkLimit;
    }

    if (form.reactionNotifications === "own") {
      delete slack.reactionNotifications;
    } else {
      slack.reactionNotifications = form.reactionNotifications;
    }
    const reactionAllowlist = parseList(form.reactionAllowlist);
    if (reactionAllowlist.length > 0) {
      slack.reactionAllowlist = reactionAllowlist;
    } else {
      delete slack.reactionAllowlist;
    }

    const slash = { ...(slack.slashCommand ?? {}) } as Record<string, unknown>;
    if (form.slashEnabled) {
      slash.enabled = true;
    } else {
      delete slash.enabled;
    }
    if (form.slashName.trim()) slash.name = form.slashName.trim();
    else delete slash.name;
    if (form.slashSessionPrefix.trim())
      slash.sessionPrefix = form.slashSessionPrefix.trim();
    else delete slash.sessionPrefix;
    if (form.slashEphemeral) {
      delete slash.ephemeral;
    } else {
      slash.ephemeral = false;
    }
    if (Object.keys(slash).length > 0) slack.slashCommand = slash;
    else delete slack.slashCommand;

    const actions: Partial<SlackActionForm> = {};
    const applyAction = (key: keyof SlackActionForm) => {
      const value = form.actions[key];
      if (value !== defaultSlackActions[key]) actions[key] = value;
    };
    applyAction("reactions");
    applyAction("messages");
    applyAction("pins");
    applyAction("memberInfo");
    applyAction("emojiList");
    if (Object.keys(actions).length > 0) {
      slack.actions = actions;
    } else {
      delete slack.actions;
    }

    const channels = form.channels
      .map((entry): [string, Record<string, unknown>] | null => {
        const key = entry.key.trim();
        if (!key) return null;
        const record: Record<string, unknown> = {
          allow: entry.allow,
          requireMention: entry.requireMention,
        };
        return [key, record];
      })
      .filter((value): value is [string, Record<string, unknown>] =>
        Boolean(value),
      );
    if (channels.length > 0) {
      slack.channels = Object.fromEntries(channels);
    } else {
      delete slack.channels;
    }

    if (Object.keys(slack).length > 0) {
      config.slack = slack;
    } else {
      delete config.slack;
    }

    const raw = `${JSON.stringify(config, null, 2).trimEnd()}\n`;
    await state.client.request("config.set", { raw });
    state.slackConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.slackConfigStatus = String(err);
  } finally {
    state.slackSaving = false;
  }
}
