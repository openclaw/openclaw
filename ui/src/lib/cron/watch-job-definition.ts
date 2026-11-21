import { readCronJobNotFoundError } from "@openclaw/gateway-protocol/gateway-error-details";
import type { CronJob } from "../../api/types.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { formatUiError } from "../format-error.ts";
import { canCallGatewayMethod } from "../gateway-methods.ts";
import { canManageCronJob } from "./human-owner.ts";
import { getCronInventory, isCronInventoryInvalidation } from "./inventory-connection.ts";
import { patchCronJobDefinition } from "./job-definition.ts";

type CardJob = Pick<
  CronJob,
  "id" | "name" | "enabled" | "ownerProfileId" | "configRevision" | "displayName"
> & { schedule?: CronJob["schedule"] };
export type CronJobObservation = {
  job?: CardJob;
  loading: boolean;
  writable: boolean;
  saving?: boolean;
  error?: string;
  readFailure?: "not-found" | "retryable";
};

/** A mounted exact-job reader, independent of the Automations page's filters and draft. */
export function watchCronJobDefinition(
  gateway: ApplicationGateway,
  id: string,
  publish: (state: CronJobObservation) => void,
) {
  let state: CronJobObservation = { loading: true, writable: false };
  let generation = 0;
  let reader: AbortController | undefined;
  let active = true;
  let awaitingWriteReconciliation = false;
  const clientForRead = () =>
    canCallGatewayMethod(gateway.snapshot, "cron.get", "operator.read", {
      requireAdvertisement: false,
    })
      ? gateway.snapshot.client
      : null;
  let client = clientForRead();
  let hello = gateway.snapshot.hello;
  let user = gateway.snapshot.selfUser?.id;
  const writable = (job?: CardJob) =>
    Boolean(
      job?.configRevision &&
      canManageCronJob(gateway, job) &&
      canCallGatewayMethod(gateway.snapshot, "cron.update", "operator.cron", {
        requireAdvertisement: false,
      }),
    );
  function update(next: CronJobObservation) {
    state = next;
    publish(next);
  }
  async function read(debounced = false) {
    reader?.abort();
    const source = client;
    if (!source) {
      update({ loading: false, writable: false });
      return;
    }
    const request = new AbortController();
    reader = request;
    update({
      ...state,
      loading: true,
      writable: !awaitingWriteReconciliation && writable(state.job),
    });
    try {
      // The connection owner coalesces bursts of definition/visibility invalidations.
      const debounce = debounced && getCronInventory(source).debounce;
      if (debounce) {
        await debounce.promise;
        request.signal.throwIfAborted();
      }
      const job = await source.request<CronJob>("cron.get", { id }, { signal: request.signal });
      if (request.signal.aborted) {
        return;
      }
      if (job?.id !== id) {
        update({ loading: false, writable: false, readFailure: "retryable" });
        return;
      }
      awaitingWriteReconciliation = false;
      update({ job, loading: false, writable: writable(job), error: state.error });
    } catch (error) {
      if (!request.signal.aborted) {
        // An exact miss is final for this view, not proof of deletion for every viewer.
        if (readCronJobNotFoundError(error)?.jobId === id) {
          update({ loading: false, writable: false, readFailure: "not-found" });
        } else {
          update({ loading: false, writable: false, readFailure: "retryable", error: state.error });
        }
      }
    }
  }
  const stopConnection = gateway.subscribe(() => {
    const next = clientForRead();
    const snapshot = gateway.snapshot;
    if (client !== next || hello !== snapshot.hello || user !== snapshot.selfUser?.id) {
      generation++;
      awaitingWriteReconciliation = false;
      client = next;
      hello = snapshot.hello;
      user = snapshot.selfUser?.id;
      state = { loading: true, writable: false };
      void read();
    } else if (
      !awaitingWriteReconciliation &&
      state.saving === undefined &&
      state.writable !== writable(state.job)
    ) {
      update({ ...state, writable: writable(state.job) });
    }
  });
  const stopEvents = gateway.subscribeEvents((event) => {
    if (
      client &&
      state.saving === undefined &&
      isCronInventoryInvalidation(event, gateway.snapshot)
    ) {
      void read(true);
    }
  });
  void read();
  return {
    retry: read,
    setEnabled(enabled: boolean) {
      const job = state.job;
      if (
        !active ||
        !job ||
        !client ||
        client !== clientForRead() ||
        !state.writable ||
        !writable(job)
      ) {
        return false;
      }
      const scope = generation;
      awaitingWriteReconciliation = true;
      reader?.abort();
      update({ job, loading: false, writable: false, saving: enabled });
      const reconcile = (outcome: { job: CronJob } | { error: string }) => {
        if (active && generation === scope) {
          // Keep a confirmed write visible; a rejection may be a conflict or lost acknowledgement.
          // Read the current revision in either case, without replaying the write.
          state = { ...state, ...outcome, saving: undefined };
          void read();
        }
      };
      void patchCronJobDefinition(client, job, { enabled }).then(
        (updated) => reconcile({ job: updated }),
        (error: unknown) => reconcile({ error: formatUiError(error) }),
      );
      return true;
    },
    dispose() {
      active = false;
      reader?.abort();
      stopEvents();
      stopConnection();
    },
  };
}
