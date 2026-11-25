import fs from "node:fs";

// Build-time artwork only. No session, host, or user data enters the scene.
const mascot = fs
  .readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8")
  .replace(/<animate(?:Transform)?\b[^>]*\/>/gu, "")
  .replace(/<!--[\s\S]*?-->/gu, "")
  .replace(/<\/?svg[^>]*>/gu, "");

export const socialPreviewFontFiles = ["Lato-Regular.ttf", "InstrumentSerif-Regular.ttf"].map(
  (name) => new URL(`../../src/gateway/assets/session-card/${name}`, import.meta.url),
);

/** A five-second seamless loop; t=0 is also the complete, readable poster. */
export function renderSocialPreviewSvg(seconds = 0): string {
  const phase = (seconds / 5) * Math.PI * 2;
  const float = Math.sin(phase) * 7;
  const orbit = [0, 1, 2]
    .map((index) => {
      const angle = phase + (index * Math.PI * 2) / 3;
      return `<circle cx="${(910 + Math.cos(angle) * 152).toFixed(2)}" cy="${(310 + Math.sin(angle) * 152).toFixed(2)}" r="5" fill="#e9746b"/>`;
    })
    .join("");
  const cards = [
    { x: 764, y: 185, text: "Imagine", delay: 0 },
    { x: 975, y: 276, text: "Create", delay: 2 },
    { x: 795, y: 422, text: "Make it real", delay: 4 },
  ]
    .map(({ x, y, text, delay }) => {
      const offset = Math.sin(phase + delay) * 4;
      return `<g transform="translate(${x} ${(y + offset).toFixed(2)})">
<rect width="156" height="50" rx="16" fill="#242421" stroke="#484640"/>
<circle cx="22" cy="25" r="4" fill="#a8caa0"/>
<text x="38" y="31" font-family="Lato" font-size="17" fill="#e5e2d9">${text}</text></g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><radialGradient id="glow"><stop stop-color="#743a30" stop-opacity=".35"/><stop offset="1" stop-color="#141413" stop-opacity="0"/></radialGradient></defs>
<rect width="1200" height="630" fill="#141413"/>
<circle cx="910" cy="310" r="295" fill="url(#glow)"/>
<rect x="22" y="22" width="1156" height="586" rx="25" fill="none" stroke="#353530"/>
<text x="76" y="100" font-family="Lato" font-size="32" fill="#f1efe8">OpenClaw</text>
<text x="1124" y="96" text-anchor="end" font-family="Lato" font-size="14" letter-spacing="2" fill="#b4b2a9">A LITTLE PROMPT. A LOT OF POSSIBILITY.</text>
<text x="76" y="290" font-family="Instrument Serif" font-size="112" fill="#f1efe8">Your ideas.</text>
<text x="76" y="407" font-family="Instrument Serif" font-size="112" fill="#e9746b">In motion.</text>
<circle cx="910" cy="310" r="152" fill="none" stroke="#4d4038" stroke-dasharray="3 8"/>
<circle cx="910" cy="310" r="104" fill="#201c19" stroke="#48352d"/>${orbit}
<g transform="translate(837 ${(237 + float).toFixed(2)})"><svg width="146" height="146" viewBox="0 0 120 120">${mascot}</svg></g>${cards}
<path d="M76 511H1124" stroke="#353530"/>
<circle cx="82" cy="554" r="5" fill="#a8caa0"/>
<text x="100" y="560" font-family="Lato" font-size="20" fill="#b4b2a9">Open source. On your terms.</text>
<text x="1124" y="560" text-anchor="end" font-family="Lato" font-size="20" fill="#b4b2a9">openclaw.ai</text></svg>`;
}
