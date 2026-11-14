import { createHash } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import MarkdownIt from "markdown-it";
import { stripInternalMetadataForDisplay } from "../auto-reply/reply/display-text-sanitize.js";
import { LOCALE_MATCH_RULES, SUPPORTED_LOCALES, RTL_LOCALES } from "../shared/control-ui-locale.js";
import {
  CONTROL_UI_TOKEN_SESSION_KEY_PREFIX,
  DEVICE_AUTH_STORAGE_KEY_PREFIX,
} from "../shared/control-ui-storage.js";
import { escapeHtml } from "../shared/html-escape.js";
import { openClawMascotStyles, renderOpenClawMascot } from "../shared/openclaw-mascot.js";
import { openClawWordmarkSvg, openClawWordmarkTextSvg } from "../shared/openclaw-wordmark.js";
import { PUBLIC_SESSION_COPY } from "../shared/public-session-copy.js";
import {
  buildPublicSessionMediaUrl,
  collectPublicSessionAttachments,
  getPublicSessionEntryId,
} from "./control-ui-public-session-attachments.js";
import { PUBLIC_SESSION_LOCALES } from "./control-ui-public-session-locales.js";
import {
  projectPublicSessionItems,
  publicSessionLinkHref,
} from "./control-ui-public-session-project.js";

type CopyKey = keyof typeof PUBLIC_SESSION_COPY;
function copyText(key: CopyKey, count?: number): string {
  return PUBLIC_SESSION_COPY[key].replace("{count}", String(count ?? ""));
}
function copyMarkup(key: CopyKey, count?: number): string {
  return (
    '<span data-public-i18n="' +
    key +
    '"' +
    (count === undefined ? "" : ' data-public-count="' + count + '"') +
    ">" +
    escapeHtml(copyText(key, count)) +
    "</span>"
  );
}
function copyLabel(key: CopyKey): string {
  return 'data-public-label="' + key + '" aria-label="' + escapeHtml(copyText(key)) + '"';
}
// Catalog bytes are fixed for the build, never conversation data; escape the HTML script boundary.
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
/** Public-reader lifecycle only: login probe, live refresh, and copy controls; never the operator app, socket, or roster. */
const PUBLIC_SESSION_ENTRY_SCRIPT = `(()=>{
  const english=${scriptJson(PUBLIC_SESSION_COPY)},locales=${scriptJson(PUBLIC_SESSION_LOCALES)};
  const supported=${scriptJson(SUPPORTED_LOCALES)},rules=${scriptJson(LOCALE_MATCH_RULES)};
  let saved;try{saved=localStorage.getItem("openclaw.i18n.locale")}catch{}
  const language=typeof navigator!=="undefined"?navigator.language||"":"";
  const locale=supported.includes(saved)?saved:(rules.find(([pattern])=>new RegExp(pattern,"i").test(language))?.[1]||"en");
  const copy={...english,...locales[locale]};
  document.documentElement.lang=locale;
  document.documentElement.dir=${scriptJson(RTL_LOCALES)}.includes(locale)?"rtl":"ltr";
  const numbers=new Intl.NumberFormat(locale);
  const t=(key,count)=>copy[key].replace("{count}",count===undefined?"":numbers.format(Number(count)));
  function localize(root){
    for(const node of root.querySelectorAll("[data-public-i18n]"))node.textContent=t(node.dataset.publicI18n,node.dataset.publicCount);
    for(const node of root.querySelectorAll("[data-public-label]"))node.setAttribute("aria-label",t(node.dataset.publicLabel));
  }
  function syncTitle(){
    const main=document.querySelector("main[data-public-session]");
    if(main&&!main.hasAttribute("data-entry-pending")){
      const title=main.querySelector(".article-head h1").textContent;
      document.title=title+" · OpenClaw";
      for(const node of main.querySelectorAll("[data-public-title]"))node.textContent=title;
      const state=main.querySelector(".article-head .reader-meta");
      if(state)main.querySelector(".reader-topbar .reader-meta")?.replaceWith(state.cloneNode(true));
    }
  }
  localize(document);syncTitle();
  const link=document.getElementById("session-login");
  function hasClientCredential(){
    if(link?.dataset.gatewayPath===undefined)return false;
    const scope=(location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+link.dataset.gatewayPath;
    let credential=new URLSearchParams(location.hash.slice(1)).get("token")?.trim();
    try{credential ||= sessionStorage.getItem(${JSON.stringify(CONTROL_UI_TOKEN_SESSION_KEY_PREFIX)}+scope)?.trim()}catch{}
    // Device scopes retain Gateway query strings; either form is only a navigation hint.
    try{
      const prefix=${JSON.stringify(DEVICE_AUTH_STORAGE_KEY_PREFIX)}+scope;
      for(let i=0;!credential&&i<localStorage.length;i++){
        const key=localStorage.key(i);
        if(key===prefix||key?.startsWith(prefix+"?"))try{credential=JSON.parse(localStorage.getItem(key)||"null")?.tokens?.operator?.token?.trim()}catch{}
      }
    }catch{}
    return Boolean(credential)
  }
  const COPY_ICONS='<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg><svg class="done" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>';
  function enhance(root){
    for(const block of root.querySelectorAll(".code")){
      if(block.querySelector(".copy"))continue;
      const button=document.createElement("button");
      button.type="button";button.className="copy";button.title=t("copy");button.setAttribute("aria-label",t("copyToClipboard"));
      button.innerHTML=COPY_ICONS;
      block.append(button);
    }
  }
  document.addEventListener("click",async event=>{
    const button=event.target.closest?.(".copy");
    const code=button?.parentElement.querySelector("code");
    if(!code)return;
    const text=code.textContent.replace(/\\n$/,"");
    let copied=false;
    try{await navigator.clipboard.writeText(text);copied=true}catch{}
    if(!copied){
      const range=document.createRange();range.selectNodeContents(code);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      try{copied=document.execCommand("copy")}catch{}
      selection.removeAllRanges();
    }
    if(!copied)return;
    button.dataset.copied="";
    clearTimeout(button.copiedTimer);
    button.copiedTimer=setTimeout(()=>{delete button.dataset.copied},1600);
  });
  enhance(document);
  window.addEventListener("message",event=>{
    if(event.data?.type!=="openclaw:widget-size"||typeof event.data.height!=="number"||!Number.isFinite(event.data.height))return;
    for(const frame of document.querySelectorAll("iframe[data-public-widget]")){
      if(frame.contentWindow===event.source){frame.style.height=Math.max(48,Math.min(8000,event.data.height))+"px";break}
    }
  });
  const pending=document.querySelector("main[data-entry-pending]");
  function showUnavailable(main){
    if(!main?.hasAttribute("data-entry-pending"))return;
    main.removeAttribute("data-entry-pending");
    document.title=main.querySelector(".entry-result h1").textContent+" · OpenClaw";
  }
  function probeFailed(){
    if(!pending)return;
    if(link)link.style.visibility="visible";
    pending.querySelector(".entry-status h1").textContent=t("accessFailed");
    pending.querySelector(".entry-status p").textContent=t("accessRetry");
  }
  /* An auth proxy in front of the Gateway (Cloudflare Access) answers signed-out probes with a login redirect. */
  if(link)fetch(link.href+"&probe=1",{credentials:"same-origin",redirect:"manual",cache:"no-store",signal:AbortSignal.timeout(5000)}).then(response=>{
    if(response.status===204||(response.status===401&&hasClientCredential()))location.replace(link.href+location.hash);
    else if(response.type==="opaqueredirect"||response.status===401||response.status===403)showUnavailable(pending);
    else probeFailed();
  }).catch(probeFailed);
  document.addEventListener("click",event=>{const login=event.target.closest?.("#session-login,[data-public-login]");if(login)login.hash=location.hash;if(event.target.closest?.("[data-public-reload]"))location.reload()});
  let timer,etag="",running=false,retryAt=0,following=false;
  const enabled=()=>document.querySelector("main[data-public-refresh='true']")!==null;
  const transcript=()=>document.querySelector(".transcript");
  const controls=document.querySelector(".reader-jump");
  const status=key=>{
    const delayed=key==="updatesDelayed"||key==="refreshFailed";
    document.querySelector("main[data-public-session]")?.toggleAttribute("data-public-delayed",delayed);
    for(const node of document.querySelectorAll("[data-public-refresh-status]")){node.dataset.publicI18n=key;node.textContent=t(key)}
  };
  function atLatest(){
    const bounds=transcript()?.getBoundingClientRect();
    return Boolean(bounds&&bounds.bottom>0&&bounds.bottom<=window.innerHeight+96);
  }
  function scrollLatest(){
    const bounds=transcript()?.getBoundingClientRect();
    const inset=controls&&!controls.hidden?Math.max(88,window.innerHeight-controls.getBoundingClientRect().top+12):88;
    if(bounds)window.scrollTo({top:Math.max(0,window.scrollY+bounds.bottom-window.innerHeight+inset),behavior:"instant"});
  }
  function updateControls(){
    const sc=document.scrollingElement||document.documentElement;
    if(controls)controls.hidden=!transcript()||sc.scrollHeight-window.scrollY-window.innerHeight<window.innerHeight*1.2;
  }
  window.addEventListener("scroll",()=>{following=enabled()&&atLatest();updateControls()},{passive:true});
  window.addEventListener("resize",updateControls);
  // Lazy images and font/layout changes must not leave a live follower behind.
  const observer=typeof ResizeObserver==="undefined"?null:new ResizeObserver(()=>{if(following&&!document.hidden)scrollLatest();updateControls()});
  function observeTranscript(){observer?.disconnect();const node=transcript();if(node)observer?.observe(node);updateControls()}
  following=enabled()&&atLatest();
  observeTranscript();
  const jitter=()=>Math.floor(Math.random()*3000);
  const schedule=(delay=15000+jitter())=>{clearTimeout(timer);if(!document.hidden&&enabled())timer=setTimeout(refresh,Math.max(delay,retryAt-Date.now()))};
  document.addEventListener("click",event=>{
    if(event.target.closest?.("[data-public-latest]")){following=enabled();scrollLatest();updateControls()}
    if(event.target.closest?.("[data-public-refresh-now]")&&enabled()&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();schedule(0)}
  });
  function carryWidgetHeights(root,heights){
    for(const frame of root.querySelectorAll("iframe[data-public-widget]")){const height=heights.get(frame.dataset.publicWidget);if(height)frame.style.height=height}
  }
  function reconcile(current,next,heights){
    const page=current.querySelector(".page"),nextPage=next.querySelector(".page");
    const previous=page?.querySelector(":scope > .transcript"),incoming=nextPage?.querySelector(":scope > .transcript");
    if(!previous||!incoming)return false;
    const oldRows=[...previous.children],newRows=[...incoming.children];
    const keyed=rows=>rows.every(row=>row.dataset.publicItem&&row.dataset.publicRevision)&&new Set(rows.map(row=>row.dataset.publicItem)).size===rows.length;
    if(!keyed(oldRows)||!keyed(newRows))return false;
    const oldByKey=new Map(oldRows.map(row=>[row.dataset.publicItem,row]));
    const kept=new Map(newRows.filter(row=>oldByKey.get(row.dataset.publicItem)?.dataset.publicRevision===row.dataset.publicRevision).map(row=>[row.dataset.publicItem,oldByKey.get(row.dataset.publicItem)]));
    const keptOrder=oldRows.filter(row=>kept.has(row.dataset.publicItem));
    if([...kept.values()].some((row,index)=>row!==keptOrder[index]))return false;
    // Never detach a retained row: moving an iframe destroys its browsing context.
    for(const node of [...previous.childNodes])if(kept.get(node.dataset?.publicItem)!==node)node.remove();
    let cursor=previous.firstChild;
    for(const row of newRows){
      const retained=kept.get(row.dataset.publicItem);
      if(retained)cursor=retained.nextSibling;
      else{carryWidgetHeights(row,heights);previous.insertBefore(row,cursor)}
    }
    for(const node of [...page.childNodes])if(node!==previous)node.remove();
    let before=true;
    for(const node of [...nextPage.childNodes]){
      if(node===incoming){before=false;continue}
      page.insertBefore(node,before?previous:null);
    }
    for(const attribute of [...current.attributes])current.removeAttribute(attribute.name);
    for(const attribute of next.attributes)current.setAttribute(attribute.name,attribute.value);
    return true;
  }
  async function refresh(){
    if(document.hidden||!enabled()||running)return;
    running=true;
    status("checkingUpdates");
    let delay;
    try{
      const response=await fetch(location.href,{credentials:"same-origin",redirect:"error",cache:"no-store",headers:etag?{"If-None-Match":etag}:{},signal:AbortSignal.timeout(10000)});
      if(response.status===429||response.status===503){const seconds=Number(response.headers.get("Retry-After"));if(Number.isFinite(seconds)&&seconds>0){delay=Math.max(15000,seconds*1000)+jitter();retryAt=Date.now()+delay}status("updatesDelayed");return}
      if(document.hidden)return;
      if(response.status===304){status("upToDate");return}
      if(response.status!==200&&response.status!==404)throw new Error("Refresh failed");
      const next=new DOMParser().parseFromString(await response.text(),"text/html");
      let main=next.querySelector("main[data-public-session]");
      const current=document.querySelector("main[data-public-session]");
      if(document.hidden||!current)return;
      if(!main){
        // Legacy token links return a plain 404 rather than a reader document.
        if(response.status===404){current.textContent=t("revoked");current.classList.remove("reader");current.dataset.publicRefresh="false";document.title=t("unavailableTitle")+" · OpenClaw";observer?.disconnect();updateControls();return}
        throw new Error("Refresh failed");
      }
      const y=window.scrollY;
      const rows=[...current.querySelectorAll("[data-public-item]")];
      const anchor=rows.find(row=>{const bounds=row.getBoundingClientRect();return bounds.bottom>0&&bounds.top<window.innerHeight});
      const anchorTop=anchor?.getBoundingClientRect().top;
      const expanded=new Set([...current.querySelectorAll("details[open][data-public-item]")].map(row=>row.dataset.publicItem));
      for(const row of main.querySelectorAll("details[data-public-item]"))row.open=expanded.has(row.dataset.publicItem);
      const heights=new Map([...current.querySelectorAll("iframe[data-public-widget]")].map(frame=>[frame.dataset.publicWidget,frame.style.height]));
      if(reconcile(current,main,heights))main=current;
      else{carryWidgetHeights(main,heights);current.replaceWith(main)}
      localize(main);enhance(main);
      document.title=next.title;syncTitle();
      // A revoked public read is already resolved; its inert script will not run here.
      showUnavailable(main);
      observeTranscript();
      if(following&&enabled())scrollLatest();
      else if(anchor&&transcript()){
        const retained=[...main.querySelectorAll("[data-public-item]")].find(row=>row.dataset.publicItem===anchor.dataset.publicItem);
        window.scrollTo({top:retained?y+retained.getBoundingClientRect().top-anchorTop:y,behavior:"instant"});
      }
      etag=response.headers.get("ETag")||"";
      status("upToDate");
    }catch{status("refreshFailed")}finally{running=false;schedule(delay)}
  }
  document.addEventListener("visibilitychange",()=>{if(document.hidden)clearTimeout(timer);else schedule(0)});
  window.addEventListener("online",()=>schedule(0));
  schedule();
})();`;

const ENTRY_SCRIPT_HASH = createHash("sha256").update(PUBLIC_SESSION_ENTRY_SCRIPT).digest("base64");
/** Both public routes serve this document, so they share one policy. Fonts and the
 * font stylesheet are the Control UI's own root assets, served under the same mount. */
export const PUBLIC_SESSION_CONTENT_SECURITY_POLICY = `default-src 'none'; img-src 'self'; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'sha256-${ENTRY_SCRIPT_HASH}'; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;

const MAX_ITEMS = 51;
const MAX_MESSAGE_CHARS = 32_768;
const MAX_DOCUMENT_CHARS = 262_144;

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
markdown.validateLink = (value) => Boolean(publicSessionLinkHref(value));
// Images must not contact third parties or load authenticated session media.
markdown.renderer.rules.image = () =>
  '<span class="omitted">' + copyMarkup("imageOmitted") + "</span>";
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index]?.attrSet("rel", "noreferrer noopener nofollow");
  return renderer.renderToken(tokens, index, options);
};
// The wrapper hosts the copy control so it stays pinned while a wide block scrolls.
for (const rule of ["fence", "code_block"] as const) {
  const render = markdown.renderer.rules[rule];
  if (render) {
    markdown.renderer.rules[rule] = (...args) => `<div class="code">${render(...args)}</div>`;
  }
}

// The Control UI lobster mark; its gradient is declared once per document in `svg.defs`.
const LOBSTER_MARK = `<svg class="mark" viewBox="0 0 120 120" aria-hidden="true" focusable="false"><path class="shell" d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10ZM20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45ZM100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z"/><path class="feeler" d="M45 15Q35 5 30 8M75 15Q85 5 90 8"/><circle class="eye" cx="45" cy="35" r="6"/><circle class="eye" cx="75" cy="35" r="6"/><circle class="pupil" cx="46" cy="34" r="2.5"/><circle class="pupil" cx="76" cy="34" r="2.5"/></svg>`;

function railIcon(paths: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" focusable="false">${paths}</svg>`;
}
// The shell's aria-hidden covers the sidebar wordmark's label.
const SIDEBAR_WORDMARK = openClawWordmarkSvg
  .replace('class="wordmark" role="img" aria-label="OpenClaw"', 'class="list-brand"')
  .replaceAll("openclaw-wordmark-shell", "openclaw-sidebar-shell");
function ghostRows(widths: number[]): string {
  return widths
    .map(
      (width) =>
        `<div class="list-row"><i class="ghost-dot"></i><i class="ghost-bar" style="width:${width}px;height:10px"></i></div>`,
    )
    .join("");
}

// Access checks and conversations share the same frame; only the first row changes.
function renderGhostFrame(heading?: string): string {
  const current = heading
    ? `<div class="list-row list-current"><span class="session-indicator" aria-hidden="true"></span><b data-public-title dir="auto">${heading}</b></div>`
    : ghostRows([148]);
  return `<div class="app-frame" aria-hidden="true"><div class="app-rail"><i class="rail-ghost rail-ghost-large"></i><i class="rail-ghost"></i><i class="rail-ghost"></i><i class="rail-ghost"></i><i class="rail-ghost"></i><span class="rail-spacer"></span><i class="rail-ghost"></i><i class="rail-ghost"></i><i class="rail-ghost rail-ghost-avatar"></i></div><div class="app-list"><div class="list-header">${SIDEBAR_WORDMARK}</div><div class="list-rows"><i class="ghost-bar" style="width:56px;height:8px"></i>${current}${ghostRows([148, 112, 170])}<i class="ghost-bar" style="width:72px;height:8px"></i>${ghostRows([130, 160, 96, 142, 118])}<i class="ghost-bar" style="width:48px;height:8px"></i>${ghostRows([150, 108, 136, 124])}</div></div></div>`;
}

const PUBLIC_SESSION_PITCH_HTML = `<section class="colophon" aria-labelledby="openclaw-pitch"><span class="made-mark" aria-hidden="true">${LOBSTER_MARK}</span><div class="made-text"><span>${copyMarkup("madeWith")}</span><h2 id="openclaw-pitch">${copyMarkup("pitchTitle")}</h2></div><div class="made-actions"><a class="button primary" href="https://docs.openclaw.ai/start/getting-started" rel="noreferrer noopener">${copyMarkup("getStarted")}</a><a class="reader-link" href="https://docs.openclaw.ai/start/why-openclaw" rel="noreferrer noopener">${copyMarkup("whyOpenClaw")}</a></div></section>`;

// Self-contained styles use the public page's light/dark tokens and Gateway-hosted fonts.
// The shared frame leaves the access-check content and unavailable anatomy intact.
const PUBLIC_SESSION_STYLES = `:root{color-scheme:dark;--bg:#0e1015;--bg-muted:#1f2330;--bg-elevated:#191c24;--hover:#1f2330;--panel:#191c24;--text:#bcbcc0;--text-strong:#f4f4f5;--muted:#8b8b94;--border:#1e2028;--border-strong:#2e3040;--accent:#ff5c5c;--bubble:rgba(255,92,92,.1);--bubble-ink:var(--text);--primary:#d13c3c;--primary-hover:#c22e2e;--link:color-mix(in srgb,#ff7070 85%,#bcbcc0);--ok:#69bf8a;--shell-light:#ff6d5a;--shell-dark:#c2372b;--eye:#050810;--mascot-ground:radial-gradient(closest-side,rgb(0 0 0/.42),rgb(0 0 0/.16) 60%,transparent);--app-content:#0e1015;--app-active-ink:#f4f4f5;--entry-ink:#bcbcc0;--entry-muted:#8e8e97;--entry-wordmark:#f4f4f5;--tile:#1c1e23;--tile-edge:#23252a;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-family:"Instrument Sans",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);font-synthesis:none;-webkit-font-smoothing:antialiased}
@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#faf9f7;--bg-muted:#efebe4;--bg-elevated:#fff;--hover:#efebe4;--panel:#f4f1ec;--text:#403c35;--text-strong:#211e1a;--muted:#6e6960;--border:#e8e4dc;--border-strong:#d6d0c5;--accent:#bd4531;--bubble:color-mix(in srgb,#bd4531 15%,#faf9f7);--bubble-ink:var(--text-strong);--primary:#bd4531;--primary-hover:#a83c29;--link:color-mix(in srgb,#a83c29 85%,#403c35);--ok:#2f9b5a;--shell-light:#ff4d4d;--shell-dark:#991b1b;--app-content:#f8f8f8;--mascot-ground:radial-gradient(closest-side,rgb(32 32 32/.16),rgb(32 32 32/.06) 60%,transparent);--app-active-ink:#202020;--entry-ink:#353535;--entry-muted:#5e5e5e;--entry-wordmark:#202020;--tile:#fbfbfb;--tile-edge:#eaeaea}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg)}a{color:var(--link);text-underline-offset:3px}a:hover{color:var(--text-strong)}a:focus-visible,.button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.defs{position:absolute;width:0;height:0;overflow:hidden}.mark .shell{fill:url(#openclaw-shell)}.mark .feeler{fill:none;stroke:var(--shell-light);stroke-width:3;stroke-linecap:round}.mark .eye{fill:var(--eye)}.mark .pupil{fill:#00e5cc}.shell-light{stop-color:var(--shell-light)}.shell-dark{stop-color:var(--shell-dark)}
`;

const PUBLIC_SESSION_ENTRY_STYLES = `.page{width:min(720px,calc(100% - 48px));margin:0 auto;padding:0 0 72px}.topbar{display:flex;align-items:center;justify-content:space-between;height:64px}.brand{display:inline-flex;align-items:center;color:var(--text-strong);text-decoration:none}.brand:hover{color:var(--text-strong)}.wordmark{display:block;width:auto;height:24px}.brand .wordmark-text{display:none}[data-entry-pending] .brand .wordmark:not(.wordmark-text){display:none}[data-entry-pending] .brand .wordmark-text{display:block}
.button{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border:1px solid var(--border);border-radius:10px;background:var(--bg-elevated);color:var(--text-strong);font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap;transition:background-color .12s ease-out,border-color .12s ease-out}.button:hover{background:var(--hover);border-color:var(--border-strong);color:var(--text-strong)}.button.primary{border-color:transparent;background:var(--primary);color:#fff}.button.primary:hover{background:var(--primary-hover);color:#fff}
.article-head{padding:56px 0 32px;margin-bottom:40px;border-bottom:1px solid var(--border)}.article-head:last-child{border-bottom:0}
h1{margin:0 0 16px;color:var(--text-strong);font-size:clamp(30px,5vw,40px);font-weight:650;line-height:1.12;letter-spacing:-.035em;overflow-wrap:anywhere;text-wrap:balance}.intro{max-width:600px;margin:0;color:var(--muted);font-size:14px;line-height:1.65}.intro strong{color:var(--text);font-weight:600}
[data-public-unavailable] .page{display:flex;flex-direction:column;min-height:100svh;padding-bottom:0}[data-public-unavailable] .article-head{margin:auto 0;padding:0 0 calc(64px + 9vh)}[data-public-unavailable] .intro{font-size:16px}
.entry-status{display:none}[data-entry-pending] .entry-result{display:none}[data-entry-pending] .entry-status{display:block}[data-entry-pending] .login{visibility:hidden}
@media(max-width:640px){.page{width:calc(100% - 36px)}.topbar{height:56px}.wordmark{height:22px}[data-public-unavailable] .article-head{padding:0 0 calc(56px + 6vh)}[data-public-unavailable] .intro{font-size:15px}.article-head{padding-top:36px;margin-bottom:32px}}
`;

const PUBLIC_SESSION_SHELL_STYLES = `[data-public-session]{--frame-radius:var(--openclaw-corner-radius-scale,1.25);--reader-radius:var(--openclaw-corner-radius-scale,1);--reader-ghost:color-mix(in srgb,var(--text) 7%,transparent);--reader-ghost-soft:color-mix(in srgb,var(--text) 2.5%,transparent)}.app-frame{display:none}.reader .app-frame,[data-entry-pending] .app-frame{position:fixed;inset-block:0;inset-inline-start:0;z-index:2;display:flex;width:336px;background:var(--bg);pointer-events:none}
.app-rail{display:flex;flex:none;flex-direction:column;align-items:center;gap:22px;width:64px;padding:14px 0 16px;background:var(--reader-ghost-soft)}.rail-ghost{display:block;width:22px;height:22px;border-radius:calc(7px * var(--frame-radius));background:var(--reader-ghost)}.rail-ghost-large{width:30px;height:30px;border-radius:calc(10px * var(--frame-radius));margin-bottom:10px}.rail-ghost-avatar{width:28px;height:28px;border-radius:50%}.rail-spacer{flex:1}
.app-list{flex:none;width:272px;min-width:0;padding:0 16px;background:var(--reader-ghost-soft)}.list-header{display:flex;align-items:center;height:52px;padding-inline-start:6px}.list-brand{display:block;width:auto;height:21px;color:var(--text-strong)}.list-rows{display:flex;flex-direction:column;height:calc(100% - 52px);padding-top:14px;overflow:hidden;-webkit-mask-image:linear-gradient(#000 0,#000 34%,transparent 92%);mask-image:linear-gradient(#000 0,#000 34%,transparent 92%)}.ghost-bar{display:block;flex:none;border-radius:999px;background:var(--reader-ghost)}.ghost-dot{flex:none;width:18px;height:18px;border-radius:50%;background:var(--reader-ghost)}.list-rows>.ghost-bar{margin:18px 0 10px 8px}.list-rows>.ghost-bar:first-child{margin-top:0}.list-row{display:flex;flex:none;align-items:center;gap:10px;height:36px;padding:0 8px;border-radius:calc(10px * var(--frame-radius))}.list-current{background:color-mix(in srgb,var(--text) 6%,transparent)}.list-current b{flex:1;font-size:13.5px;font-weight:500}
@media(max-width:1080px){.app-list{display:none}.reader .app-frame,[data-entry-pending] .app-frame{width:64px}}
@media(max-width:760px){.reader .app-frame,[data-entry-pending] .app-frame{display:none}}
[data-entry-pending]{min-height:100svh;background:var(--app-content)}@media(min-width:1081px){[data-entry-pending]{padding-inline-start:336px}}@media(min-width:761px) and (max-width:1080px){[data-entry-pending]{padding-inline-start:64px}}
@media(max-width:900px){[data-entry-pending] .topbar{position:relative;height:56px}[data-entry-pending] .brand{position:absolute;top:16.6px;left:calc(50% - 50.4px)}[data-entry-pending] .wordmark{height:25.25px}}
[data-entry-pending]{position:relative}[data-entry-pending] .page{position:relative;width:auto;min-height:100svh;margin:0;padding:0}[data-entry-pending] .article-head{margin:0;padding:0;border:0}
/* Every status page shares one anatomy: the mascot stands above a centred title, which holds a fixed height a little above centre. */
[data-entry-pending] .entry-status{position:absolute;top:38%;left:50%;width:min(460px,calc(100% - 48px));transform:translateX(-50%);text-align:center}
[data-entry-pending] .entry-status h1{position:relative;margin:0;color:var(--entry-wordmark);font-size:22px;font-weight:600;line-height:28px;letter-spacing:-.01em;text-wrap:balance}
[data-entry-pending] .entry-status .intro{max-width:none;margin:6px 0 0;color:var(--entry-muted);font-size:14px;line-height:21px;text-wrap:pretty}
.entry-actions{display:none;align-items:center;justify-content:center;gap:8px;min-height:32px;margin-top:20px}[data-entry-pending]:has(.login[style*="visible"]) .entry-actions{display:flex}
[data-entry-pending] .button{height:32px;padding:0 14px;border:0;border-radius:12px;font:inherit;font-size:13px;font-weight:500}[data-entry-pending] .button span[aria-hidden]{display:none}
[data-entry-pending] .login{background:color-mix(in srgb,var(--app-active-ink) 11%,var(--app-content));color:var(--app-active-ink)}[data-entry-pending] .login:hover{background:color-mix(in srgb,var(--app-active-ink) 15%,var(--app-content));color:var(--app-active-ink)}
@media(min-width:901px){[data-entry-pending] .topbar{position:absolute;top:10px;inset-inline-end:16px;z-index:1;height:auto;padding:0}[data-entry-pending] .brand{display:none}}
@media(max-width:900px){[data-entry-pending] .topbar{height:56px;padding:0 12px}[data-entry-pending] .login{margin-inline-start:auto}[data-entry-pending] .entry-status{top:36%;left:24px;right:24px;width:auto;transform:none}[data-entry-pending] .entry-status h1{font-size:20px;line-height:26px}}
@media(max-width:900px),(pointer:coarse){[data-entry-pending] .button{height:36px;padding:0 16px;border-radius:13px;font-size:14px}}
${openClawMascotStyles({
  // While access is checked the mascot is the busy indicator; once the check fails it looks down at Reload.
  busy: "[data-entry-pending] .mascot",
  error: '[data-entry-pending]:has(.login[style*="visible"]) .mascot',
  phone: "@media(max-width:900px)",
})}`;

// Message prose keeps macOS stem darkening; page chrome remains antialiased.
const PUBLIC_SESSION_READER_STYLES = `.reader{--accent:#cd3535;--bubble:color-mix(in srgb,var(--accent) 11%,var(--bg));--reader-soft:color-mix(in srgb,var(--text) 4%,transparent);font-family:"Space Grotesk",-apple-system,system-ui,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.6;letter-spacing:-.01em}
.reader .brand{display:inline-flex;color:var(--text-strong)}.reader .wordmark{display:block;width:auto;height:21px}
.reader .button{gap:0;display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;border:0;border-radius:calc(10px * var(--reader-radius));background:var(--reader-ghost);color:var(--text-strong);font-size:13px;font-weight:500;text-decoration:none;white-space:nowrap;transition:background .1s ease-out}.reader .button:hover{background:color-mix(in srgb,var(--text) 11%,transparent)}.reader .button.primary{background:var(--accent);color:#fff}.reader .button.primary:hover{background:color-mix(in srgb,var(--accent) 90%,#000)}
.reader-link{color:var(--muted);font-size:13px;font-weight:500;text-decoration:none;border-radius:6px}.reader-link:hover{color:var(--text-strong)}
.reader a:focus-visible,.reader summary:focus-visible,.reader .copy:focus-visible,.reader-jump:focus-visible{outline:0;box-shadow:0 0 0 2px var(--bg),0 0 0 3px color-mix(in srgb,var(--accent) 70%,transparent)}
.reader-topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:16px;height:52px;margin-inline-start:336px;padding:0 16px 0 20px;background:color-mix(in srgb,var(--bg) 86%,transparent);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}.reader-topbar .brand{display:none}.reader-title{flex:1;min-width:0;display:flex;align-items:center;gap:0}.reader-title b{flex:0 1 auto;padding-inline-end:14px;font-size:15px;font-weight:600;letter-spacing:-.005em;-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 14px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 14px),transparent)}.reader-title b,.list-current b{min-width:0;overflow:hidden;white-space:nowrap;color:var(--text-strong)}.list-current b{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 32px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 32px),transparent)}[dir=rtl] .reader-title b{-webkit-mask-image:linear-gradient(270deg,#000 calc(100% - 14px),transparent);mask-image:linear-gradient(270deg,#000 calc(100% - 14px),transparent)}[dir=rtl] .list-current b{-webkit-mask-image:linear-gradient(270deg,#000 calc(100% - 32px),transparent);mask-image:linear-gradient(270deg,#000 calc(100% - 32px),transparent)}
.reader-badge{flex:none;display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:calc(7px * var(--reader-radius));background:color-mix(in srgb,var(--text) 6%,transparent);color:var(--muted);font-size:12px;font-weight:500;line-height:1;white-space:nowrap}
.reader-actions{display:flex;align-items:center;gap:8px}.reader-actions .reader-why{margin-inline-end:8px}.reader-topbar .button{height:32px}.reader .login>span[aria-hidden]{display:none}
.reader-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin:0;color:var(--muted);font-size:13px;line-height:20px;font-variant-numeric:tabular-nums}.reader-title .reader-meta{flex:none;flex-wrap:nowrap;margin-inline-start:14px}.reader .live{display:inline-flex;align-items:center;gap:6px;color:var(--ok);font-weight:500}.reader .live::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.reader .refresh-detail{color:var(--text)}
.reader:not([data-public-delayed]) .reader-title .reader-meta[data-live],.reader:not([data-public-delayed]) .refresh-detail,.speaker{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.reader:not([data-public-delayed]) [data-public-refresh-now],.reader[data-public-delayed] .live{display:none}
.reader-main{margin-inline-start:336px}.reader .page{width:min(720px,calc(100% - 40px));margin:0 auto;padding:28px 0 104px}.reader .article-head{display:none;margin-bottom:36px;padding:0;border:0}.reader .article-head h1{margin:0 0 8px;color:var(--text-strong);font-size:26px;font-weight:600;line-height:1.18;letter-spacing:-.02em;text-wrap:balance;overflow-wrap:anywhere}

.session-indicator{flex:none;width:18px;height:18px;display:grid;place-items:center}.session-indicator::before{box-sizing:border-box;content:"";width:18px;height:18px;border-radius:50%;background:var(--reader-ghost)}.reader[data-public-refresh=true]:not([data-public-delayed]) .session-indicator::before{width:13px;height:13px;background:transparent;border:2px solid color-mix(in srgb,var(--accent) 22%,transparent);border-top-color:var(--accent);animation:reader-spin .9s linear infinite}@keyframes reader-spin{to{rotate:360deg}}@media(prefers-reduced-motion:reduce){.reader .session-indicator::before{animation:none!important}}
.transcript{display:flex;flex-direction:column;gap:22px}.user{display:flex;justify-content:flex-end}.user .content{max-width:min(80%,560px);padding:10px 15px;border-radius:calc(20px * var(--reader-radius));background:var(--bubble);color:var(--text-strong);font-size:15px}.assistant{position:relative}.avatar{position:absolute;top:0;inset-inline-start:-42px;width:28px;height:28px}.avatar .mark{display:block;width:100%;height:100%}
.content{min-width:0;font-size:15.5px;line-height:1.65;overflow-wrap:anywhere;color:var(--text);-webkit-font-smoothing:auto}.content>:first-child{margin-top:0}.content>:last-child{margin-bottom:0}.content p,.content ul,.content ol,.content .code,.content table,.content blockquote{margin:0 0 .8em}.content strong{color:var(--text-strong);font-weight:600}.content h1,.content h2,.content h3,.content h4{margin:1.4em 0 .5em;color:var(--text-strong);font-size:1.05em;line-height:1.4}.content ul,.content ol{padding-inline-start:1.3em}.content li{margin:.25em 0}.content li::marker{color:var(--muted)}.content blockquote{position:relative;padding:4px 12px;color:var(--muted)}.content blockquote::before{content:"";position:absolute;top:4px;bottom:4px;inset-inline-start:0;width:3px;border-radius:9999px;background:var(--border-strong)}.content hr{margin:1.5em 0;border:0;border-top:1px solid var(--border)}
.content code{font-family:var(--mono);font-size:.86em}.content :not(pre)>code{padding:.12em .36em;border-radius:6px;background:color-mix(in srgb,var(--text) 6%,transparent);color:var(--text-strong)}.code{position:relative;direction:ltr;text-align:left}.content pre{margin:0;overflow:auto;padding:12px 46px 12px 14px;border-radius:calc(14px * var(--reader-radius));background:var(--reader-soft);font-size:13px;line-height:1.65;scrollbar-width:none}.content pre code{font-size:1em}
.copy{font:inherit;position:absolute;top:7px;right:7px;display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:calc(8px * var(--reader-radius));background:none;color:var(--muted);cursor:pointer;opacity:0;transition:opacity .12s ease-out}.copy svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}.copy .done{display:none}.copy[data-copied] svg{display:none}.copy[data-copied] .done{display:block;color:var(--ok)}.copy:hover{background:color-mix(in srgb,var(--text) 8%,transparent);color:var(--text)}.code:hover .copy,.copy:focus-visible,.copy[data-copied]{opacity:1}@media(hover:none){.copy{opacity:1}}
.content table{display:block;width:max-content;max-width:100%;overflow:auto;border-collapse:collapse;font-size:14px}.content th,.content td{padding:6px 18px 6px 0;text-align:start}.content th{color:var(--muted);font-weight:500;font-size:13px}.image{display:block;margin-top:10px}.image img{display:block;max-width:100%;height:auto;border-radius:calc(12px * var(--reader-radius))}.widget{display:block;width:100%;border:0;background:transparent;margin-top:12px;border-radius:8px}.attachment{display:inline-flex;align-items:center;max-width:100%;min-height:26px;margin:8px 6px 0 0;padding:0 10px;border-radius:calc(8px * var(--reader-radius));background:var(--reader-ghost);font-size:13px;overflow-wrap:anywhere}
.omitted,.reader-fine,.empty,.reader .notice{color:var(--muted);font-size:13px;line-height:1.55}.empty{margin:0;font-size:14px}.reader-fine{margin:0;max-width:560px;text-wrap:pretty}.reader-end{margin-top:44px}.reader .notice{margin:0 0 10px;max-width:560px;text-wrap:pretty}
.tools{min-width:0;margin:-8px 0;overflow-wrap:anywhere}.tools summary{display:inline-flex;align-items:center;gap:4px;height:28px;margin-inline-start:-8px;padding:0 6px 0 8px;border-radius:calc(8px * var(--reader-radius));color:var(--muted);font-size:13px;font-weight:500;list-style:none;cursor:pointer;user-select:none}.tools summary::-webkit-details-marker{display:none}.tools summary:hover{background:var(--hover);color:var(--text)}.tool-chevron{display:inline-flex}.tool-chevron svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:rotate .12s ease-out}.tools[open] .tool-chevron svg{rotate:90deg}.tools ul{display:grid;gap:4px;margin:6px 0 2px;padding:0;list-style:none}.tools li{display:grid;grid-template-columns:44px minmax(0,1fr);gap:10px;font-size:12.5px;line-height:20px}.tools li code{font-family:var(--mono);color:var(--text)}.tools li span{font-family:var(--mono);color:var(--muted);overflow-wrap:anywhere}.tools .omitted{margin:6px 0 0;max-width:560px;text-wrap:pretty}
.pagination a{display:inline-flex;align-items:center;gap:6px;height:28px;margin:0 0 20px -8px;padding:0 10px 0 8px;border-radius:calc(8px * var(--reader-radius));color:var(--muted);font-size:13px;font-weight:500;text-decoration:none}.pagination a:hover{background:var(--hover);color:var(--text)}.pagination a>span[aria-hidden]{display:inline-flex}.pagination svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.reader-jump{font:inherit;position:fixed;left:50%;bottom:max(20px,env(safe-area-inset-bottom));z-index:6;display:grid;place-items:center;width:36px;height:36px;margin-left:-18px;padding:0;border:0;border-radius:50%;background:var(--bg-elevated);color:var(--text);box-shadow:0 0 0 1px color-mix(in srgb,var(--text) 9%,transparent),0 6px 20px rgb(0 0 0/.1);cursor:pointer}.reader-jump svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.colophon{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:14px;margin-top:20px;padding:14px 16px 14px 14px;border-radius:calc(18px * var(--reader-radius));background:var(--reader-soft)}.made-mark{display:block;width:34px;height:34px}.made-mark svg{display:block;width:100%;height:100%}.made-text{display:grid;gap:1px;min-width:0}.made-text>span{color:var(--muted);font-size:12.5px;line-height:18px}.made-text h2{margin:0;color:var(--text-strong);font-size:14.5px;font-weight:600;line-height:20px;text-wrap:balance}.made-actions{display:flex;align-items:center;gap:14px}
@media(min-width:761px){.reader-jump{left:calc(50% + 32px)}[dir=rtl] .reader-jump{left:calc(50% - 32px)}}
@media(min-width:1081px){.reader-topbar{padding-inline-start:max(20px,calc((100vw - 336px - 720px)/2))}.reader-jump{left:calc(50% + 168px)}[dir=rtl] .reader-jump{left:calc(50% - 168px)}}
@media(max-width:1080px){.reader-topbar,.reader-main{margin-inline-start:64px}.reader-topbar .brand{display:inline-flex}.reader-title{display:none}.reader .article-head{display:block}.reader .article-head .reader-badge{margin-top:10px}.reader .page{padding-top:36px}}
@media(max-width:860px){.assistant{display:grid;grid-template-columns:26px minmax(0,1fr);gap:0 10px}.avatar{position:static;width:26px;height:26px}.assistant>.content{grid-column:2}.tools{padding-inline-start:36px}}
@media(max-width:760px){.reader-topbar,.reader-main{margin-inline-start:0}.reader-topbar{height:56px;padding:0 14px 0 16px;gap:10px}.reader-topbar .brand{display:inline-flex}.reader-topbar .reader-title,.reader-actions .reader-why{display:none}.reader-actions{margin-inline-start:auto;gap:4px}.reader-actions .login{background:none;border:0;box-shadow:none;padding:0 10px}.reader .article-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-bottom:18px}.reader .article-head h1{order:0;flex-basis:100%;margin:0 0 4px;font-size:22px;line-height:1.2;letter-spacing:-.01em}.reader .article-head .reader-badge{order:1;margin-top:0}.reader .article-head .reader-meta[data-live]{order:2}.reader .article-head .reader-meta:not([data-live]),.reader[data-public-delayed] .article-head .reader-meta{order:3;flex-basis:100%}.reader .article-head:has(.reader-meta:not([data-live])),.reader[data-public-delayed] .article-head{margin-bottom:22px}.colophon{grid-template-columns:34px minmax(0,1fr)}.made-actions{grid-column:1 / -1}}
@media(max-width:760px){[data-entry-pending] .topbar{padding:0 14px 0 16px}[data-entry-pending] .brand{position:static}[data-entry-pending] .brand .wordmark:not(.wordmark-text){display:block;height:21px}[data-entry-pending] .brand .wordmark-text{display:none}}
@media(max-width:560px){.reader .page{width:calc(100% - 32px);padding-top:20px}.user .content{max-width:88%}}

`;

export function publicSessionTitle(title: string): string {
  return (
    truncateUtf16Safe(stripInternalMetadataForDisplay(title), 200).trim() ||
    PUBLIC_SESSION_COPY.sharedConversation
  );
}

export function renderPublicSessionDocument(params: {
  messages: unknown[];
  mediaBaseUrl?: string;
  widgetUrls?: ReadonlyMap<string, string>;
  title: string;
  truncated: boolean;
  latestUrl: string;
  canonicalUrl?: string;
  cardUrl: string;
  olderUrl?: string;
  isLatest?: boolean;
  entryUrl?: string;
  clientAuthBasePath?: string;
  /** Control UI mount that serves the public `fonts/` root assets. */
  assetBasePath: string;
  unavailable?: boolean;
}): string {
  const isLatest = params.isLatest !== false && !params.unavailable;
  const entryPending = params.unavailable && Boolean(params.entryUrl);
  const entryLink = params.entryUrl
    ? `<a class="button login" id="session-login"${params.clientAuthBasePath !== undefined ? ` data-gateway-path="${escapeHtml(params.clientAuthBasePath)}"` : ""} href="${escapeHtml(params.entryUrl)}">${copyMarkup("logIn")} <span aria-hidden="true">→</span></a>`
    : "";
  const title = escapeHtml(publicSessionTitle(params.title));
  const projected = projectPublicSessionItems(params.messages);
  let truncated = params.truncated || projected.length > MAX_ITEMS;
  let remaining = MAX_DOCUMENT_CHARS;
  const entries: { role: "user" | "assistant" | "tools"; html: string; key?: string }[] = [];
  // Budget newest visible items first, then restore conversational order.
  for (const item of projected.slice(-MAX_ITEMS).toReversed()) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (item.kind === "tools") {
      const lines: string[] = [];
      for (const call of item.calls) {
        const line = `<li dir="auto"><code dir="ltr">${escapeHtml(call.name)}</code>${call.summary ? ` <span>${escapeHtml(call.summary)}</span>` : ""}</li>`;
        if (line.length > remaining) {
          truncated = true;
          break;
        }
        remaining -= line.length;
        lines.push(line);
      }
      entries.push({
        role: "tools",
        html: `<details class="tools"><summary>${copyMarkup(item.calls.length === 1 ? "toolOne" : "toolOther", item.calls.length)}<span class="tool-chevron" aria-hidden="true">${railIcon('<path d="m9 18 6-6-6-6"/>')}</span></summary><ul>${lines.join("")}</ul>${lines.length < item.calls.length ? '<p class="omitted">' + copyMarkup("stepsOmitted") + "</p>" : ""}</details>`,
      });
      continue;
    }
    const text = truncateUtf16Safe(item.text, Math.min(MAX_MESSAGE_CHARS, remaining));
    const clipped = text.length < item.text.length;
    truncated ||= clipped;
    remaining -= text.length;
    const entryId = getPublicSessionEntryId(item.message);
    const media: string[] = [];
    for (const attachment of collectPublicSessionAttachments(item.message)) {
      const name = escapeHtml(truncateUtf16Safe(attachment.name, 200));
      const url =
        params.mediaBaseUrl && entryId && attachment.image
          ? escapeHtml(buildPublicSessionMediaUrl(params.mediaBaseUrl, entryId, attachment.id))
          : undefined;
      const html = url
        ? `<a class="image" href="${url}" target="_blank" rel="noreferrer noopener"><img src="${url}" alt="${name}" loading="lazy"></a>`
        : `<span class="attachment">${name}</span>`;
      if (html.length > remaining) {
        truncated = true;
        break;
      }
      remaining -= html.length;
      media.push(html);
    }
    for (const embed of item.embeds) {
      const widgetUrl = embed.kind === "widget" ? params.widgetUrls?.get(embed.docId) : undefined;
      let html: string;
      if (embed.kind === "link") {
        html = `<p><a href="${escapeHtml(embed.href)}" rel="noreferrer noopener nofollow">${escapeHtml(embed.title ?? embed.href)}</a></p>`;
      } else if (widgetUrl) {
        html = `<iframe class="widget" src="${escapeHtml(widgetUrl)}" title="${embed.title ? escapeHtml(embed.title) : title}" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy" data-public-widget="${escapeHtml(embed.docId)}" style="height:${embed.height ?? 420}px"></iframe>`;
      } else {
        continue;
      }
      if (html.length > remaining) {
        truncated = true;
        break;
      }
      remaining -= html.length;
      media.push(html);
    }
    entries.push({
      role: item.role,
      key: entryId,
      html: `${markdown.render(text)}${clipped ? '<p class="omitted">' + copyMarkup("messageShortened") + "</p>" : ""}${media.join("")}`,
    });
  }
  const rows = entries.toReversed().map((entry, index, ordered) => {
    // Stable across latest-page rollover; expose an opaque digest, not source metadata.
    const key = createHash("sha256")
      .update(entry.key ?? `${entry.role}:${entry.html}`)
      .digest("hex")
      .slice(0, 24);
    const continued = ordered[index - 1]?.role === entry.role;
    const html =
      entry.role === "tools"
        ? entry.html.replace(
            '<details class="tools"',
            `<details class="tools" data-public-item="${key}"`,
          )
        : `<article class="message ${entry.role}${continued ? " continued" : ""}" data-public-item="${key}" ${copyLabel(entry.role === "user" ? "userMessage" : "assistantMessage")}><h2 class="speaker">${entry.role === "user" ? copyMarkup("user") : "OpenClaw"}</h2>${entry.role === "assistant" && !continued ? `<span class="avatar" aria-hidden="true">${LOBSTER_MARK}</span>` : ""}<div class="content" dir="auto">${entry.html}</div></article>`;
    const revision = createHash("sha256").update(html).digest("hex").slice(0, 24);
    return html.replace(
      `data-public-item="${key}"`,
      `data-public-item="${key}" data-public-revision="${revision}"`,
    );
  });
  const description = params.unavailable
    ? "Log in to open conversations you have access to."
    : "A public, read-only OpenClaw conversation. No login required.";
  const canonicalMetadata = params.canonicalUrl
    ? `<link rel="canonical" href="${escapeHtml(params.canonicalUrl)}">
<meta property="og:url" content="${escapeHtml(params.canonicalUrl)}">`
    : "";
  const navigation = params.olderUrl
    ? `<nav class="pagination" ${copyLabel("conversationPages")}><a href="${escapeHtml(params.olderUrl)}" rel="prev"><span aria-hidden="true">${railIcon('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>')}</span>${copyMarkup("olderMessages")}</a></nav>`
    : "";
  const heading = !stripInternalMetadataForDisplay(params.title).trim()
    ? copyMarkup("sharedConversation")
    : title;
  const state = `<p class="reader-meta"${isLatest ? " data-live" : ""}>${isLatest ? `<span class="live">${copyMarkup("live")}</span><span class="refresh-detail" data-public-refresh-status role="status" data-public-i18n="liveUpdates">${copyText("liveUpdates")}</span><a class="reader-link" data-public-refresh-now href="${escapeHtml(params.latestUrl)}">${copyMarkup("refreshNow")}</a>` : `${copyMarkup("earlierConversation")}<a class="reader-link" href="${escapeHtml(params.latestUrl)}">${copyMarkup("backToLatest")}</a>`}</p>`;
  const badge = `<span class="reader-badge">${copyMarkup("publicSession")}</span>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow">
${isLatest ? '<noscript><meta http-equiv="refresh" content="15"></noscript>' : ""}
<title>${entryPending ? "OpenClaw" : `${title} · OpenClaw`}</title>${canonicalMetadata}
<meta property="og:type" content="website"><meta property="og:site_name" content="OpenClaw">
<meta property="og:title" content="${title}"><meta property="og:description" content="${description}">
<meta property="og:image" content="${escapeHtml(params.cardUrl)}">
<meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${title} · OpenClaw public session">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${escapeHtml(params.cardUrl)}"><meta name="twitter:image:alt" content="${title} · OpenClaw public session">
<link rel="stylesheet" href="${escapeHtml(params.assetBasePath)}/fonts/instrument-sans.css">
${params.unavailable ? "" : `<link rel="stylesheet" href="${escapeHtml(params.assetBasePath)}/fonts/space-grotesk.css"><link rel="stylesheet" href="${escapeHtml(params.assetBasePath)}/fonts/jetbrains-mono.css">`}
<style>
${PUBLIC_SESSION_STYLES}
${PUBLIC_SESSION_ENTRY_STYLES}
${PUBLIC_SESSION_SHELL_STYLES}
${PUBLIC_SESSION_READER_STYLES}
</style>${entryPending ? "<noscript><style>[data-entry-pending] .entry-result{display:block}[data-entry-pending] .entry-status{display:none}[data-entry-pending] .login{visibility:visible}[data-entry-pending] .app-frame{display:none}</style></noscript>" : ""}</head><body><main data-public-session${params.unavailable ? "" : ' class="reader"'}${params.unavailable ? " data-public-unavailable" : ""}${entryPending ? " data-entry-pending" : ""} data-public-refresh="${isLatest ? "true" : "false"}">
<svg class="defs" aria-hidden="true" focusable="false"><linearGradient id="openclaw-shell" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="shell-light"/><stop offset="1" class="shell-dark"/></linearGradient></svg>
${
  params.unavailable
    ? `${entryPending ? renderGhostFrame() : ""}<div class="page">
<header class="topbar"><a class="brand" href="https://openclaw.ai" rel="noreferrer noopener">${openClawWordmarkSvg}${entryPending ? openClawWordmarkTextSvg : ""}</a>${entryLink}</header>
<header class="article-head">${entryPending ? '<div class="entry-status" role="status">' + renderOpenClawMascot("openclaw-mascot-shell") + "<h1>" + copyMarkup("loadingConversation") + '</h1><p class="intro">' + copyMarkup("checkingAccess") + '</p><div class="entry-actions"><button class="button primary" type="button" data-public-reload>' + copyMarkup("reload") + '</button></div></div><div class="entry-result">' : ""}<h1 dir="auto">${copyMarkup("unavailableTitle")}</h1><p class="intro">${copyMarkup("unavailable")}</p>${entryPending ? "</div>" : ""}</header>
${truncated ? '<aside class="notice">' + copyMarkup("omittedHistory") + "</aside>" : ""}${navigation}${navigation}</div>`
    : `${renderGhostFrame(heading)}
<header class="reader-topbar"><a class="brand" href="https://openclaw.ai" rel="noreferrer noopener">${openClawWordmarkSvg}</a><div class="reader-title"><b data-public-title dir="auto">${heading}</b>${badge}${state}</div><div class="reader-actions"><a class="reader-link reader-why" href="https://docs.openclaw.ai/start/why-openclaw" rel="noreferrer noopener">${copyMarkup("whyOpenClaw")}</a>${entryLink}<a class="button primary" href="https://docs.openclaw.ai/start/getting-started" rel="noreferrer noopener">${copyMarkup("getStarted")}</a></div></header>
<div class="reader-main"><div class="page"><header class="article-head"><h1 dir="auto">${heading}</h1>${state}${badge}</header>
${truncated ? '<aside class="notice">' + copyMarkup("omittedHistory") + "</aside>" : ""}${navigation}
<section class="transcript" ${copyLabel("conversation")}>${rows.length ? rows.join("\n") : `<p class="empty">${copyMarkup(isLatest ? "emptyLive" : "emptyPage")}</p>`}</section>
<p class="reader-fine reader-end">${copyMarkup(isLatest ? "liveDescription" : "pageDescription")} ${copyMarkup("revocationNotice")}</p>${PUBLIC_SESSION_PITCH_HTML}</div></div>`
}
</main>${params.unavailable ? "" : `<button class="reader-jump" type="button" data-public-latest ${copyLabel(isLatest ? "goToLatest" : "goToEnd")} hidden>${railIcon('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>')}</button>`}<script>${PUBLIC_SESSION_ENTRY_SCRIPT}</script></body></html>`;
}
