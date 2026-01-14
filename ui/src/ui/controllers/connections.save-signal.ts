import { parseList } from "../format";
import type { ConnectionsState } from "./connections.types";

export async function saveSignalConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.signalSaving) return;
  state.signalSaving = true;
  state.signalConfigStatus = null;
  try {
    const base = state.configSnapshot?.config ?? {};
    const config = { ...base } as Record<string, unknown>;
    const signal = { ...(config.signal ?? {}) } as Record<string, unknown>;
    const form = state.signalForm;

    if (form.enabled) {
      delete signal.enabled;
    } else {
      signal.enabled = false;
    }

    const account = form.account.trim();
    if (account) signal.account = account;
    else delete signal.account;

    const httpUrl = form.httpUrl.trim();
    if (httpUrl) signal.httpUrl = httpUrl;
    else delete signal.httpUrl;

    const httpHost = form.httpHost.trim();
    if (httpHost) signal.httpHost = httpHost;
    else delete signal.httpHost;

    const httpPort = Number(form.httpPort);
    if (Number.isFinite(httpPort) && httpPort > 0) {
      signal.httpPort = httpPort;
    } else {
      delete signal.httpPort;
    }

    const cliPath = form.cliPath.trim();
    if (cliPath) signal.cliPath = cliPath;
    else delete signal.cliPath;

    if (form.autoStart) {
      delete signal.autoStart;
    } else {
      signal.autoStart = false;
    }

    if (form.receiveMode === "on-start" || form.receiveMode === "manual") {
      signal.receiveMode = form.receiveMode;
    } else {
      delete signal.receiveMode;
    }

    if (form.ignoreAttachments) signal.ignoreAttachments = true;
    else delete signal.ignoreAttachments;
    if (form.ignoreStories) signal.ignoreStories = true;
    else delete signal.ignoreStories;
    if (form.sendReadReceipts) signal.sendReadReceipts = true;
    else delete signal.sendReadReceipts;

    const allowFrom = parseList(form.allowFrom);
    if (allowFrom.length > 0) signal.allowFrom = allowFrom;
    else delete signal.allowFrom;

    const mediaMaxMb = Number(form.mediaMaxMb);
    if (Number.isFinite(mediaMaxMb) && mediaMaxMb > 0) {
      signal.mediaMaxMb = mediaMaxMb;
    } else {
      delete signal.mediaMaxMb;
    }

    if (Object.keys(signal).length > 0) {
      config.signal = signal;
    } else {
      delete config.signal;
    }

    const raw = `${JSON.stringify(config, null, 2).trimEnd()}\n`;
    await state.client.request("config.set", { raw });
    state.signalConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.signalConfigStatus = String(err);
  } finally {
    state.signalSaving = false;
  }
}

