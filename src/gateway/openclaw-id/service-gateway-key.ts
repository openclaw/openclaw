// The OpenClaw ID service's access to K_gw. A linked claw signs only with the key
// its stored binding names and never creates one (openclaw-aab); an unlinked claw
// creates its key on first use. The key module loads only when a key is needed, so
// a Gateway with the Labs switch off never imports it.
import type { OpenClawIdAuthority } from "./authority.js";
import type { GatewayKeyRefusedError } from "./gateway-key.js";
import type { BoundKeyRefusal } from "./tunnel-child/keyfile.js";

type GatewayKey = Awaited<ReturnType<typeof import("./gateway-key.js").loadGatewaySigner>>;

export function createServiceGatewayKey(params: {
  getStateDir: () => string;
  getAuthority: () => Promise<OpenClawIdAuthority>;
}) {
  /** Loads K_gw; a linked claw's missing or different key throws GatewayKeyRefusedError. */
  const load = async (): Promise<GatewayKey> => {
    const [{ loadGatewaySigner }, owner] = await Promise.all([
      import("./gateway-key.js"),
      params.getAuthority(),
    ]);
    return await loadGatewaySigner(params.getStateDir(), owner.current()?.binding?.body.k_gw);
  };

  /** Loads K_gw, returning a linked claw's key refusal instead of throwing it. */
  const tryLoad = async (): Promise<
    ({ ok: true } & GatewayKey) | { ok: false; refused: GatewayKeyRefusedError }
  > => {
    const { GatewayKeyRefusedError } = await import("./gateway-key.js");
    try {
      return { ok: true, ...(await load()) };
    } catch (error) {
      if (error instanceof GatewayKeyRefusedError) {
        return { ok: false, refused: error };
      }
      throw error;
    }
  };

  return {
    load,
    tryLoad,
    /** Why a linked claw's K_gw is unusable; undefined when it is usable or the claw is unlinked. */
    async refusal(): Promise<BoundKeyRefusal | undefined> {
      if (!(await params.getAuthority()).current()?.binding) {
        return undefined;
      }
      const loaded = await tryLoad();
      return loaded.ok ? undefined : loaded.refused.reason;
    },
  };
}
