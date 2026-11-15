import { hashConfigRaw } from "../../config/io.read-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";

export function doctorConfigRevision(snapshot: Pick<ConfigFileSnapshot, "path" | "hash" | "raw">) {
  return {
    path: snapshot.path,
    hash: snapshot.hash ?? hashConfigRaw(snapshot.raw),
  };
}

export async function finalizeDoctorConfigFlow(params: {
  cfg: OpenClawConfig;
  candidate: OpenClawConfig;
  snapshot: Pick<ConfigFileSnapshot, "path" | "hash" | "raw">;
  pendingChanges: boolean;
  shouldRepair: boolean;
  fixHints: string[];
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  note: (message: string, title?: string) => void;
}): Promise<{
  cfg: OpenClawConfig;
  shouldWriteConfig: boolean;
  confirmedConfigSource: { path: string; hash: string };
}> {
  const confirmedConfigSource = doctorConfigRevision(params.snapshot);
  let cfg = params.cfg;
  let shouldWriteConfig = params.shouldRepair && params.pendingChanges;
  if (!params.shouldRepair && params.pendingChanges) {
    shouldWriteConfig = await params.confirm({
      message: "Apply recommended config repairs now?",
      initialValue: true,
    });
    if (shouldWriteConfig) {
      cfg = params.candidate;
    } else if (params.fixHints.length > 0) {
      params.note(params.fixHints.join("\n"), "Doctor");
    }
  }
  return { cfg, shouldWriteConfig, confirmedConfigSource };
}
