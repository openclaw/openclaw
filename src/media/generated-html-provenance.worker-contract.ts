import type { Selectable } from "kysely";
import type { DB } from "../state/openclaw-state-db.generated.js";

export type GeneratedHtmlProvenanceRow = Selectable<DB["outbound_media_provenance"]>;

export type GeneratedHtmlProvenanceReadOperations = {
  "generatedHtmlProvenance.read": {
    input: string;
    output: {
      type: "generatedHtmlProvenance.read";
      marker: { sha256: string; size: number } | undefined;
    };
  };
  "generatedHtmlProvenance.list": {
    input: undefined;
    output: { type: "generatedHtmlProvenance.list"; rows: GeneratedHtmlProvenanceRow[] };
  };
};

export type GeneratedHtmlProvenanceOperations = {
  "generatedHtmlProvenance.upsert": { input: GeneratedHtmlProvenanceRow; output: number };
  "generatedHtmlProvenance.prune": { input: GeneratedHtmlProvenanceRow[]; output: number };
};
