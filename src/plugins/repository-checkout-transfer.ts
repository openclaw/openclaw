import type {
  WorkerTunnelHandle,
  WorkerWorkspaceSyncRequest,
} from "../gateway/worker-environments/tunnel-contract.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type CheckoutCredential = {
  token?: string;
  assertCurrent: () => void;
  start: <T>(run: () => Promise<T>) => Promise<T>;
};

class CheckoutTransfer {
  readonly #dispatch: (credential: CheckoutCredential) => Promise<void>;
  #used = false;
  constructor(dispatch: (credential: CheckoutCredential) => Promise<void>) {
    this.#dispatch = dispatch;
    Object.setPrototypeOf(this, null);
  }
  static async execute(transfer: CheckoutTransfer, credential: CheckoutCredential) {
    if (!(#dispatch in transfer) || transfer.#used) {
      throw new Error("Repository checkout transfer is no longer available.");
    }
    transfer.#used = true;
    await transfer.#dispatch(credential);
  }
}
// SDK source transforms and native chunks consume the same private transfer brand.
const SharedCheckoutTransfer = resolveGlobalSingleton(
  Symbol.for("openclaw.repositoryCheckoutTransfer"),
  () => CheckoutTransfer,
);
export type RepositoryCheckoutTransfer = CheckoutTransfer;

/** The host binds target and current authority; a source supplies only effect-scoped credentials. */
export function createRepositoryCheckoutTransfer(
  tunnel: Pick<WorkerTunnelHandle, "syncWorkspace">,
  request: WorkerWorkspaceSyncRequest,
  assertCurrent: () => void,
) {
  let result: Awaited<ReturnType<WorkerTunnelHandle["syncWorkspace"]>> | undefined;
  const transfer = new SharedCheckoutTransfer(async (credential) => {
    const assertLive = () => {
      assertCurrent();
      credential.assertCurrent();
    };
    assertLive();
    result = await credential.start(async () => {
      assertLive();
      if (request.source.kind !== "repository") {
        throw new Error("Repository checkout requires a repository source.");
      }
      return await tunnel.syncWorkspace({
        ...request,
        source: { ...request.source, ...(credential.token ? { gitToken: credential.token } : {}) },
        authorize: assertLive,
      });
    });
    assertLive();
  });
  return {
    transfer,
    result() {
      if (!result) {
        throw new Error("Repository source did not dispatch its checkout transfer.");
      }
      return result;
    },
  };
}

/** A credential is consumed only by the exact host-bound transport, never returned or persisted. */
export async function performRepositoryCheckout(
  transfer: RepositoryCheckoutTransfer,
  credential: CheckoutCredential,
): Promise<void> {
  await SharedCheckoutTransfer.execute(transfer, credential);
}
