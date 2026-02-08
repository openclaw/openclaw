export * from "./accounts.js";
export * from "./config.js";
export * from "./access.js";
export * from "./pairing-store.js";
export * from "./directory-store.js";
export * from "./targets.js";
export * from "../channels/plugins/outbound/dingtalk.js";

type MonitorDingTalkProvider = typeof import("./monitor.js").monitorDingTalkProvider;
type ProbeDingTalk = typeof import("./probe.js").probeDingTalk;

export async function monitorDingTalkProvider(...args: Parameters<MonitorDingTalkProvider>) {
  const mod = await import("./monitor.js");
  return mod.monitorDingTalkProvider(...args);
}

export async function probeDingTalk(...args: Parameters<ProbeDingTalk>) {
  const mod = await import("./probe.js");
  return mod.probeDingTalk(...args);
}
