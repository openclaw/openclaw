import { resolveGlobalSingleton } from "../shared/global-singleton.js";
type AdmissionOwnerState = { ensure: (() => Promise<string | undefined>) | undefined };
const state = resolveGlobalSingleton<AdmissionOwnerState>(
  Symbol.for("openclaw.supervisedTaskAdmissionOwner"),
  () => ({ ensure: undefined }),
);
export function registerSupervisedTaskAdmissionOwner(ensure: () => Promise<string | undefined>) {
  state.ensure = ensure;
  return () => {
    if (state.ensure === ensure) {
      state.ensure = undefined;
    }
  };
}
export async function ensureSupervisedTaskAdmissionOwner() {
  const ensure = state.ensure;
  if (!ensure) {
    throw new Error("No native supervision service is available to accept this task");
  }
  const owner = await ensure();
  if (!owner || state.ensure !== ensure) {
    throw new Error("Supervision service has not accepted custody");
  }
  return owner;
}
