import { createMemo } from "solid-js";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";

const hues = [8, 32, 48, 82, 142, 174, 202, 232, 272, 322] as const;

/** The agent ID keeps every feature stable across clients and render order. */
export function AgentAvatarFace(props: { agentId: string }) {
  const id = createMemo(() => props.agentId);
  const face = createMemo(() => {
    const seed = fnv1aUtf16(id());
    const hue = hues[seed % hues.length];
    // Consume separate digits so palette and expression can vary independently.
    const eyeSeed = Math.floor(seed / hues.length);
    const mouthSeed = Math.floor(eyeSeed / 4);
    return {
      eye: eyeSeed % 4,
      mouth: mouthSeed % 4,
      background: `hsl(${hue} ${Math.floor(mouthSeed / 4) % 2 === 1 ? "65% 90%" : "58% 62%"})`,
      pale: `hsl(${hue} 65% 90%)`,
      ink: `hsl(${hue} 55% 18%)`,
    };
  });
  const stroke = (d: string) => (
    <path d={d} fill="none" stroke={face().ink} stroke-width="1.6" stroke-linecap="round" />
  );
  return (
    <svg
      class="identity-avatar__agent-face"
      viewBox="0 0 32 32"
      width="100%"
      height="100%"
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="16" fill={face().background} />
      <g fill={face().ink}>
        {face().eye === 0 ? (
          <>
            <circle cx="11" cy="13.5" r="1.6" />
            <circle cx="21" cy="13.5" r="1.6" />
          </>
        ) : face().eye === 1 ? (
          <>
            <ellipse cx="11" cy="13" rx="1.5" ry="2" />
            <ellipse cx="21" cy="13" rx="1.5" ry="2" />
          </>
        ) : face().eye === 2 ? (
          stroke("M9 14q2-3 4 0m6 0q2-3 4 0")
        ) : (
          <>
            <rect x="6.5" y="9" width="19" height="9.5" rx="4.75" />
            <g fill={face().pale}>
              <rect x="10.5" y="12" width="2.5" height="3.5" rx="1.25" />
              <rect x="19" y="12" width="2.5" height="3.5" rx="1.25" />
            </g>
          </>
        )}
        {face().mouth === 0 ? (
          stroke("M11.5 20q4.5 4.5 9 0")
        ) : face().mouth === 1 ? (
          <>
            <path d="M11 19q5 1.5 10 0c-.5 4.5-3 6-5 6s-4.5-1.5-5-6Z" />
            <path d="M13.5 23q2.5-2 5 0-2.5 2-5 0Z" fill={face().pale} />
          </>
        ) : face().mouth === 2 ? (
          stroke("M12 22q5 2 8-1")
        ) : (
          stroke("M13.5 22.5h5")
        )}
      </g>
    </svg>
  );
}
