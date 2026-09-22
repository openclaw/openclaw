// Final doctor config-write decision after preview/repair mode has collected mutations.
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";

/** Decide whether doctor should write the repaired candidate config or only print hints. */
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
  confirmedConfigSource?: { path: string; hash: string };
}> {
  if (!params.shouldRepair && params.pendingChanges) {
    const confirmedConfigSource = {
      path: params.snapshot.path,
      hash: params.snapshot.hash ?? hashConfigRaw(params.snapshot.raw),
    };
    const shouldApply = await params.confirm({
      message: "Apply recommended config repairs now?",
      initialValue: true,
    });
    if (shouldApply) {
      return {
        cfg: params.candidate,
        shouldWriteConfig: true,
        confirmedConfigSource,
      };
    }
    if (params.fixHints.length > 0) {
      params.note(params.fixHints.join("\n"), "Doctor");
    }
    return {
      cfg: params.cfg,
      shouldWriteConfig: false,
    };
  }

  if (params.shouldRepair && params.pendingChanges) {
    return {
      cfg: params.cfg,
      shouldWriteConfig: true,
    };
  }

  return {
    cfg: params.cfg,
    shouldWriteConfig: false,
  };
}
