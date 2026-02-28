import os from "node:os";

export type OsSummary = {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  label: string;
};

export function resolveOsSummary(): OsSummary {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  const label =
    platform === "win32" ? `windows ${release} (${arch})` : `${platform} ${release} (${arch})`;
  return { platform, arch, release, label };
}
