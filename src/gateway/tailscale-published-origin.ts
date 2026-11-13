import { setMaxListeners } from "node:events";

type TailscalePublishedOrigin = {
  origin: string;
  mode: "serve" | "funnel";
};

let publishedOrigin: (TailscalePublishedOrigin & { owner: AbortController }) | undefined;
let nextServe = announcementOwner();

function announcementOwner() {
  const owner = new AbortController();
  // Every hello bound to this route state subscribes until it closes; a Gateway may have many peers.
  setMaxListeners(0, owner.signal);
  return owner;
}

/** Publish only a live managed route; its owner withdraws the origin on exit or shutdown. */
export function prepareTailscalePublishedOrigin(snapshot: TailscalePublishedOrigin): () => void {
  const url = new URL(snapshot.origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Tailscale published origin must be an absolute HTTPS origin");
  }
  const owner = announcementOwner();
  const previous = publishedOrigin?.owner;
  // Publish the replacement before retiring clients that may immediately reconnect.
  publishedOrigin = { origin: url.origin, mode: snapshot.mode, owner };
  previous?.abort();
  if (snapshot.mode === "serve") {
    const waiting = nextServe;
    nextServe = announcementOwner();
    waiting.abort();
  }
  return () => {
    if (publishedOrigin?.owner === owner) {
      publishedOrigin = undefined;
    }
    owner.abort();
  };
}

export function getTailscalePublishedOrigin():
  | (TailscalePublishedOrigin & { signal: AbortSignal })
  | undefined {
  return publishedOrigin
    ? {
        origin: publishedOrigin.origin,
        mode: publishedOrigin.mode,
        signal: publishedOrigin.owner.signal,
      }
    : undefined;
}

/** Aborts when the next Serve origin is published, retiring answers given while none was live. */
export function getNextTailscaleServeSignal(): AbortSignal {
  return nextServe.signal;
}
