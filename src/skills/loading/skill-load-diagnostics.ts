import { truncateUtf16WithEllipsis } from "../../shared/text-truncate.js";
import type { LocalSkillLoadDiagnostic } from "./local-loader.js";

export type SkillLoadDiagnostics = {
  items: LocalSkillLoadDiagnostic[];
  omitted: number;
};

const MAX_DIAGNOSTICS = 64;
const MAX_DIAGNOSTIC_PATH_CHARS = 4096;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 1024;

/** Retains bounded discovery facts without keeping parser errors or instruction text alive. */
export function createSkillLoadDiagnostics() {
  const items: LocalSkillLoadDiagnostic[] = [];
  let omitted = 0;
  const add = (diagnostic: LocalSkillLoadDiagnostic) => {
    if (items.length >= MAX_DIAGNOSTICS) {
      omitted += 1;
      return;
    }
    items.push(
      structuredClone({
        kind: diagnostic.kind,
        path: truncateUtf16WithEllipsis(diagnostic.path, MAX_DIAGNOSTIC_PATH_CHARS),
        message: truncateUtf16WithEllipsis(diagnostic.message, MAX_DIAGNOSTIC_MESSAGE_CHARS),
      }),
    );
  };
  return {
    add,
    merge(snapshot?: SkillLoadDiagnostics) {
      if (!snapshot) {
        return;
      }
      const count = Math.min(MAX_DIAGNOSTICS - items.length, snapshot.items.length);
      for (let index = 0; index < count; index += 1) {
        add(snapshot.items[index]!);
      }
      omitted += snapshot.omitted + snapshot.items.length - count;
    },
    snapshot(): SkillLoadDiagnostics {
      return {
        items: items.map((item) => ({ kind: item.kind, path: item.path, message: item.message })),
        omitted,
      };
    },
  };
}
