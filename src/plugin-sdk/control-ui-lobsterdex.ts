import type {
  LobsterCatalogEntry,
  LobsterPose,
} from "../../packages/gateway-protocol/src/lobsterdex.js";

/** Core definitions and enabled plugin contributions share one rendering surface. */
export type ControlUiClawmoji =
  | LobsterCatalogEntry
  | {
      id: string;
      name: string;
      description?: string;
      source: "builtin";
      appearance: { kind: "builtin"; paletteId: string };
    };

export type ControlUiLobsterInventoryEntry = {
  id: string;
  firstSeenAt: number | null;
  name: string | null;
  shinySeenAt: number | null;
  available: boolean;
};

export type ControlUiLobsterdex = {
  /** Reads this browser's collection; previewing a character never records a visit. */
  listInventory: () => readonly ControlUiLobsterInventoryEntry[];
  listCatalog: () => readonly ControlUiClawmoji[];
  getDefinition: (id: string) => ControlUiClawmoji | undefined;
  /** Fetch the current enabled pack catalog. Rejects on a connection/read failure. */
  refresh: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  /** Report an actual encounter; core owns timestamps and preserves first sightings. */
  recordEncounter: (id: string, details?: { name?: string; shiny?: boolean }) => void;
};

export type ControlUiClawmojiProps = {
  clawmojiId: string;
  pose?: LobsterPose;
  size?: number;
  label: string;
};
