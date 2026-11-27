import type { GatewayBrowserClient } from "../../api/gateway.ts";

/** Leaf contract shared by the dictation owner and its lazy capture module. */
export type ComposerDictationFailure = {
  kind: "interrupted" | "start" | "busy";
  preservesText: boolean;
};

export type ComposerDictationOwnerOptions = {
  client: GatewayBrowserClient | null;
  sessionKey?: string;
  prepareSession?: () => Promise<string | undefined>;
  draftKey?: string;
  /** Connection/account identity from the existing composer scope owner. */
  contextKey?: string;
  corrections?: { mode: "off" | "explicit"; locale: string };
  getDraftRevision?: () => number;
  captureDraftGuard?: () => () => boolean;
  connected: boolean;
  enabled: boolean;
  dictationAvailable?: boolean;
  realtimeTalkActive: boolean;
  onCommit: (text: string, late?: true, preservePreview?: true, ownedOnly?: true) => void;
  onError: (message: string, failure: ComposerDictationFailure) => void;
  onTap?: () => void;
  onDictationUnavailable?: () => void;
};
