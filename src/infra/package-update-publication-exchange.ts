import fsp from "node:fs/promises";
import path from "node:path";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { packageActivationIdentityOrAbsent as entryIdentity } from "./package-update-activation-custody.js";
import type {
  PackageActivationIntent,
  PackageActivationPhase,
  PackageActivationRecord,
} from "./package-update-activation-journal.js";
import type { PackageIntegrityFingerprint } from "./package-update-integrity.js";
import { exchangePaths, supportsPathExchange, type PathExchangeResult } from "./path-exchange.js";

/**
 * Publishes a journaled candidate with one atomic exchange, so the package path
 * names a complete recorded generation at every instant. Under a recorded
 * `publish` intent the candidate takes the name `previous`, and one exchange
 * then leaves the candidate installed and the previous generation under
 * `previous`: the names every reader already knows after a publication.
 *
 * The one state this adds is the candidate waiting under `previous` beside the
 * untouched installed package. It is accepted only with that recorded intent and
 * all three recorded identities, and `restore` returns it to the untouched
 * layout, so no other reader has to classify it. The installed package in that
 * state is still the one whose updater wrote the journal.
 */
export function publicationExchange<Observed extends { selected: "previous" | "candidate" | null }>(
  anchor: string,
  read: () => PackageActivationRecord,
  assertCurrent: () => void,
  transition: (phase: PackageActivationPhase, intent: PackageActivationIntent) => void,
  inspect: (contents: "staged" | "none") => Promise<Observed>,
) {
  let outcome: PathExchangeResult | undefined;
  const previous = path.join(anchor, "previous");
  const candidate = path.join(anchor, "candidate");
  const observe = () => {
    const { descriptor, intent } = read();
    const live = descriptor.authority.installKey;
    const installed = entryIdentity(live, true) === descriptor.previous.identity;
    const waiting = (name: string, other: string) =>
      installed &&
      entryIdentity(name, true) === descriptor.candidate.identity &&
      entryIdentity(other, true) === null;
    return {
      live,
      descriptor,
      staged: waiting(candidate, previous),
      waiting: intent?.kind === "publish" && waiting(previous, candidate),
    };
  };
  /** The candidate is back under its own name; persist that before the journal moves on. */
  const persistReturn = async () => {
    assertCurrent();
    requireDirectorySync(await syncDirectory(anchor), "Package exchange candidate");
  };
  return {
    /** How the last publication by this owner went; undefined when no exchange was tried. */
    outcome: () => outcome,
    /** Returns a waiting candidate to its own name before any reader classifies the layout. */
    async restore(): Promise<void> {
      if (!observe().waiting) {
        return;
      }
      assertCurrent();
      await fsp.rename(previous, candidate);
      // An exchange tool that outlived its updater can still publish between that
      // observation and this rename. The previous package then held the name: it
      // goes back, and the publication is read as published.
      if (entryIdentity(candidate, true) === read().descriptor.previous.identity) {
        assertCurrent();
        await fsp.rename(candidate, previous);
      }
      await persistReturn();
    },
    /**
     * Returns the observed layout once the candidate is installed, or undefined
     * when this publication must take the two moves: a resumed operation, a
     * platform without the call, or an exchange that reported `unavailable`.
     */
    async publish(
      resume: boolean,
      observed: Observed,
      onDisplaced?: (
        previous: PackageIntegrityFingerprint,
        copied: boolean,
      ) => void | Promise<void>,
    ): Promise<Observed | undefined> {
      if (resume || observed.selected !== "previous" || !supportsPathExchange()) {
        return undefined;
      }
      // Recheck the candidate before publishing its directory.
      await inspect("staged");
      transition("publishing", { kind: "publish" });
      const { live, descriptor, staged } = observe();
      if (!staged) {
        throw new Error("Package exchange preimage changed.");
      }
      await fsp.rename(candidate, previous);
      assertCurrent();
      outcome = await exchangePaths(previous, live, assertCurrent);
      if (outcome.status === "unavailable") {
        assertCurrent();
        await fsp.rename(previous, candidate);
        await persistReturn();
        return undefined;
      }
      // Persist both sides before the caller learns the previous package is retained.
      for (const directory of [anchor, path.dirname(live)]) {
        assertCurrent();
        requireDirectorySync(await syncDirectory(directory), "Package exchange");
      }
      const published = await inspect("none");
      await onDisplaced?.(descriptor.previous, false);
      return published;
    },
  };
}
