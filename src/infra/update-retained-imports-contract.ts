// Shared by the build, which emits these package bytes, and the installed
// updater, which reads them about itself before package replacement.

/** Dist file listing the chunks an updater without module hooks preloads before replacement. */
export const UPDATE_PRELOAD_IMPORTS_FILE = "update-preload-imports.json";

/**
 * `package.json` `openclaw.updateRetainedImports` value declaring that this
 * release's updater serves its own later imports on every supported runtime,
 * so later builds need no update-compat bridges for it.
 */
export const UPDATE_RETAINED_IMPORTS_PROTOCOL = 1;
