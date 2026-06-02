let embeddedModeValue = false;

/** Sets the process-local embedded-mode flag used by runtime entry points. */
export function setEmbeddedMode(value: boolean): void {
  embeddedModeValue = value;
}

/** Returns whether the current process is running under an embedded host. */
export function isEmbeddedMode(): boolean {
  return embeddedModeValue;
}
