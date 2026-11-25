import type { GatewayHelloOk } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

/** Shares plugin body interest without changing the application event stream. */
export function createGatewayMessageBodyInterest(
  getSnapshot: () => ApplicationGatewaySnapshot,
  onError: (error: string) => void,
) {
  let listeners = 0;
  let connectPreference = false;
  let requested: {
    hello: GatewayHelloOk | null;
    includeMessageBodies: boolean;
    failed: boolean;
  } | null = null;

  const synchronize = (retryFailed = false) => {
    const snapshot = getSnapshot();
    if (snapshot.phase !== "connected" || !snapshot.client) {
      requested = null;
      return;
    }
    if (!requested || requested.hello !== snapshot.hello) {
      requested = {
        hello: snapshot.hello,
        includeMessageBodies: connectPreference,
        failed: false,
      };
    }
    const includeMessageBodies = listeners > 0;
    if (
      requested.includeMessageBodies === includeMessageBodies &&
      !(retryFailed && requested.failed)
    ) {
      return;
    }
    const request = { hello: snapshot.hello, includeMessageBodies, failed: false };
    requested = request;
    const { client } = snapshot;
    void client
      .request<{ subscribed?: boolean }>("sessions.subscribe", { includeMessageBodies })
      .then((result) => {
        if (result?.subscribed !== true) {
          throw new Error("Gateway did not activate the session event subscription");
        }
      })
      .catch((error: unknown) => {
        const current = getSnapshot();
        if (
          current.phase === "connected" &&
          current.client === client &&
          current.hello === request.hello &&
          requested === request
        ) {
          request.failed = true;
          onError(formatUiError(error));
        }
      });
  };

  return {
    get connectPreference() {
      // Capture the value actually sent by this handshake, including reconnects.
      connectPreference = listeners > 0;
      return connectPreference || undefined;
    },
    synchronize,
    retain() {
      listeners += 1;
      synchronize(true);
      let retained = true;
      return () => {
        if (!retained) {
          return;
        }
        retained = false;
        listeners -= 1;
        synchronize();
      };
    },
  };
}
