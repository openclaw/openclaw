import { resolveGlobalSingleton } from "../shared/global-singleton.js";
/** One accepted Git operation. Plugins supply credentials without receiving or replacing the command. */
class PublicationGitTransfer {
  readonly #dispatch: (credential: PublicationGitCredential) => Promise<void>;
  #used = false;
  constructor(dispatch: (credential: PublicationGitCredential) => Promise<void>) {
    this.#dispatch = dispatch;
    Object.setPrototypeOf(this, null);
  }
  static async execute(transfer: PublicationGitTransfer, credential: PublicationGitCredential) {
    if (!(#dispatch in transfer) || transfer.#used) {
      throw new Error("Publication Git transfer is no longer available.");
    }
    transfer.#used = true;
    await transfer.#dispatch(credential);
  }
}
// SDK source transforms and native chunks consume the same private transfer brand.
const SharedPublicationGitTransfer = resolveGlobalSingleton(
  Symbol.for("openclaw.repositoryPublicationGitTransfer"),
  () => PublicationGitTransfer,
);
export type RepositoryPublicationGitTransfer = PublicationGitTransfer;
type PublicationGitCredential = { httpAuthorization: string; assertCurrent(): void };

/** Host-only creation keeps workspace, accepted ref, and execution custody in the transaction owner. */
export function createRepositoryPublicationGitTransfer<T>(
  run: (httpAuthorization: string, assertCredential: () => void) => Promise<T>,
  assertCurrent: () => void,
) {
  let result: { value: T } | undefined;
  const transfer = new SharedPublicationGitTransfer(async (credential) => {
    const assertLive = () => {
      assertCurrent();
      credential.assertCurrent();
    };
    assertLive();
    const value = await run(credential.httpAuthorization, assertLive);
    // A dispatched write's observation is returned to execution custody before action revalidation.
    result = { value };
  });
  return {
    transfer,
    result() {
      if (!result) {
        throw new Error("Publisher did not dispatch its accepted Git transfer.");
      }
      return result.value;
    },
  };
}
export async function performRepositoryPublicationGit(
  transfer: RepositoryPublicationGitTransfer,
  credential: PublicationGitCredential,
): Promise<void> {
  await SharedPublicationGitTransfer.execute(transfer, credential);
}
