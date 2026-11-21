import QRCode from "qrcode";
import { createMemo } from "solid-js";

/** QR quiet zone in modules; scanners need four on every side. */
const QUIET_ZONE = 4;

/** Render `value` as a client-side SVG QR code; the encoded text never leaves the browser. */
export function QrCode(props: { value: string; label: string; size: string }) {
  const symbol = createMemo(() => {
    const { size, data } = QRCode.create(props.value, { errorCorrectionLevel: "M" }).modules;
    let path = "";
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!data[y * size + x]) {
          continue;
        }
        let run = 1;
        while (x + run < size && data[y * size + x + run]) {
          run += 1;
        }
        path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${run}v1h-${run}z`;
        x += run - 1;
      }
    }
    return { extent: size + QUIET_ZONE * 2, path };
  });
  // Dark-on-white in every theme: inverted codes fail on many scanners.
  return (
    <svg
      class="qr-code"
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${symbol().extent} ${symbol().extent}`}
      shape-rendering="crispEdges"
      style={{
        display: "block",
        flex: "none",
        width: props.size,
        "aspect-ratio": "1",
        "box-sizing": "border-box",
        border: "1px solid var(--border)",
        "border-radius": "6px",
        background: "#fff",
      }}
    >
      <path fill="#000" d={symbol().path} />
    </svg>
  );
}
