import { i18n } from "../i18n/index.ts";
import { isStaleChunkImportError, scheduleStaleChunkReload } from "./stale-chunk-reload.ts";

// This policy is needed before the shell loads, including sign-in and focus documents.
i18n.setLocaleLoadRecovery({
  isUnrecoverableError: isStaleChunkImportError,
  onUnrecoverableLocaleLoad: () => {
    // Chrome and WebKit can pin failed dynamic imports for the document. Keep the
    // shared guarded reload owner instead of adding a locale-specific retry path.
    void scheduleStaleChunkReload();
  },
});
