import { asFiniteNumberInRange } from "@openclaw/normalization-core/number-coercion";

type PortRange = { start: number; end: number };

/** Default browser-CDP sidecar port range used when no browser-control-relative range is safe. */
const DEFAULT_BROWSER_CDP_PORT_RANGE_START = 18800;
/** Inclusive end of the default browser-CDP sidecar port range. */
const DEFAULT_BROWSER_CDP_PORT_RANGE_END = 18899;
const DEFAULT_BROWSER_CDP_PORT_RANGE_SPAN =
  DEFAULT_BROWSER_CDP_PORT_RANGE_END - DEFAULT_BROWSER_CDP_PORT_RANGE_START;

/** Derives the browser-CDP sidecar range from the browser-control port when it fits. */
export function deriveDefaultBrowserCdpPortRange(browserControlPort: number): PortRange {
  const start =
    asFiniteNumberInRange(browserControlPort + 9, { min: 0, minExclusive: true, max: 65535 }) ??
    DEFAULT_BROWSER_CDP_PORT_RANGE_START;
  const end = start + DEFAULT_BROWSER_CDP_PORT_RANGE_SPAN;
  if (end <= 65535) {
    return { start, end };
  }
  // Preserve the full expected range width; wrapping or clamping only the end would make the
  // dynamic range smaller than callers advertise.
  return {
    start: DEFAULT_BROWSER_CDP_PORT_RANGE_START,
    end: DEFAULT_BROWSER_CDP_PORT_RANGE_END,
  };
}
