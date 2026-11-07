/**
 * The OpenClaw mascot from the brand wordmark (ui/src/assets/brand/openclaw-horizontal-*-text.svg),
 * inlined for status documents the Gateway serves without the Control UI bundle. Its claws, eyes
 * and lids are separate groups so CSS alone can move them: no script, no external asset.
 */
export function renderOpenClawMascot(gradientId: string): string {
  const fill = `url(#${gradientId})`;
  return `<span class="mascot" aria-hidden="true"><span class="mascot-ground"></span><svg class="mascot-figure" viewBox="-2 2 124 112" focusable="false"><defs><linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs><g fill="none" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round"><path d="M45 15 Q35 5 30 8"/><path d="M75 15 Q85 5 90 8"/></g><g class="mascot-claw mascot-claw-left"><path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="${fill}"/></g><g class="mascot-claw mascot-claw-right"><path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="${fill}"/></g><path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="${fill}"/><g class="mascot-eyes"><g class="mascot-lids"><circle cx="45" cy="35" r="6" fill="#181A1F"/><circle cx="75" cy="35" r="6" fill="#181A1F"/><circle cx="46" cy="34" r="2.5" fill="#DDE2E9" opacity=".82"/><circle cx="76" cy="34" r="2.5" fill="#DDE2E9" opacity=".82"/></g></g></svg></span>`;
}

/**
 * Status-page mascot styles. It stands 88px (80px on phones) on a soft ground shadow, 24px above
 * the title it is placed in. `busy` selects the mascot while work runs: it bobs, the ground
 * shrinks, the claws open and the eyes scan. `error` selects it once the page settles on an
 * action: it stands still and looks down toward the button. The ground follows `--mascot-ground`.
 */
export function openClawMascotStyles(selectors: {
  busy: string;
  error: string;
  phone: string;
}): string {
  const ease = "cubic-bezier(.45,0,.55,1)";
  return `.mascot{--mascot-size:88px;--mascot-gx:0px;--mascot-gy:0px;position:absolute;top:calc(-24px - var(--mascot-size));left:50%;width:var(--mascot-size);height:var(--mascot-size);transform:translateX(-50%);pointer-events:none}
.mascot-ground{position:absolute;bottom:0;left:50%;width:62px;height:9px;margin-left:-31px;border-radius:50%;background:var(--mascot-ground)}
.mascot-figure{position:absolute;top:0;left:0;display:block;width:100%;height:auto;aspect-ratio:124/112;overflow:visible}
.mascot-eyes{transform:translate(var(--mascot-gx),var(--mascot-gy));transition:transform .5s cubic-bezier(.3,0,.2,1)}.mascot-lids{transform-origin:60px 35px}.mascot-claw-left{transform-origin:28px 52px}.mascot-claw-right{transform-origin:92px 52px}
${selectors.busy} .mascot-figure{animation:mascot-bob 2.6s ${ease} infinite alternate}${selectors.busy} .mascot-ground{animation:mascot-ground 2.6s ${ease} infinite alternate}${selectors.busy} .mascot-claw-left{animation:mascot-pinch-left 2.6s ${ease} infinite alternate}${selectors.busy} .mascot-claw-right{animation:mascot-pinch-right 2.6s ${ease} infinite alternate}${selectors.busy} .mascot-eyes{animation:mascot-gaze 4.8s cubic-bezier(.45,0,.2,1) infinite}${selectors.busy} .mascot-lids{animation:mascot-blink 4.8s linear infinite}
${selectors.error}{--mascot-gy:2.8px}${selectors.error} *{animation:none}
@keyframes mascot-bob{from{transform:translateY(0)}to{transform:translateY(-5px)}}@keyframes mascot-ground{from{transform:scaleX(1);opacity:1}to{transform:scaleX(.82);opacity:.7}}@keyframes mascot-pinch-left{from{transform:rotate(0)}to{transform:rotate(-7deg)}}@keyframes mascot-pinch-right{from{transform:rotate(0)}to{transform:rotate(7deg)}}
@keyframes mascot-gaze{0%,8%,82%,100%{transform:translate(0,0)}18%,40%{transform:translate(-3.2px,.6px)}50%,72%{transform:translate(3.2px,.6px)}}@keyframes mascot-blink{0%,90%,96%,100%{transform:scaleY(1)}93%{transform:scaleY(.12)}}
@media(prefers-reduced-motion:reduce){${selectors.busy} .mascot-eyes{animation-duration:12s}${selectors.busy} :is(.mascot-figure,.mascot-ground,.mascot-claw,.mascot-lids){animation:none}}
${selectors.phone}{.mascot{--mascot-size:80px}}`;
}
