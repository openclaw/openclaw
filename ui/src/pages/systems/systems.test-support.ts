import type { SystemInfoResult } from "@openclaw/gateway-protocol";

export const systemInfo: SystemInfoResult = {
  machineName: "Test Gateway",
  hostname: "gateway.test",
  platform: "linux",
  release: "test",
  arch: "x64",
  osLabel: "Linux",
  nodeVersion: "v26",
  pid: 1,
  uptimeMs: 1_000,
  cpuCount: 4,
  memoryTotalBytes: 8_192,
  memoryFreeBytes: 4_096,
};
