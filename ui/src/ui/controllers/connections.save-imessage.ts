import { parseList } from "../format";
import type { ConnectionsState } from "./connections.types";

export async function saveIMessageConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.imessageSaving) return;
  state.imessageSaving = true;
  state.imessageConfigStatus = null;
  try {
    const base = state.configSnapshot?.config ?? {};
    const config = { ...base } as Record<string, unknown>;
    const imessage = { ...(config.imessage ?? {}) } as Record<string, unknown>;
    const form = state.imessageForm;

    if (form.enabled) {
      delete imessage.enabled;
    } else {
      imessage.enabled = false;
    }

    const cliPath = form.cliPath.trim();
    if (cliPath) imessage.cliPath = cliPath;
    else delete imessage.cliPath;

    const dbPath = form.dbPath.trim();
    if (dbPath) imessage.dbPath = dbPath;
    else delete imessage.dbPath;

    if (form.service === "auto") {
      delete imessage.service;
    } else {
      imessage.service = form.service;
    }

    const region = form.region.trim();
    if (region) imessage.region = region;
    else delete imessage.region;

    const allowFrom = parseList(form.allowFrom);
    if (allowFrom.length > 0) imessage.allowFrom = allowFrom;
    else delete imessage.allowFrom;

    if (form.includeAttachments) imessage.includeAttachments = true;
    else delete imessage.includeAttachments;

    const mediaMaxMb = Number(form.mediaMaxMb);
    if (Number.isFinite(mediaMaxMb) && mediaMaxMb > 0) {
      imessage.mediaMaxMb = mediaMaxMb;
    } else {
      delete imessage.mediaMaxMb;
    }

    if (Object.keys(imessage).length > 0) {
      config.imessage = imessage;
    } else {
      delete config.imessage;
    }

    const raw = `${JSON.stringify(config, null, 2).trimEnd()}\n`;
    await state.client.request("config.set", { raw });
    state.imessageConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.imessageConfigStatus = String(err);
  } finally {
    state.imessageSaving = false;
  }
}

