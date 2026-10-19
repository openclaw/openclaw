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
import { PUBLIC_SESSION_COPY } from "../shared/public-session-copy.js";
import {
  buildPublicSessionMediaUrl,
  collectPublicSessionAttachments,
  getPublicSessionEntryId,
} from "./control-ui-public-session-attachments.js";
import { PUBLIC_SESSION_LOCALES } from "./control-ui-public-session-locales.js";
import { projectPublicSessionItems } from "./control-ui-public-session-project.js";

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
    if(main&&!main.hasAttribute("data-entry-pending"))document.title=main.querySelector(".article-head h1").textContent+" · OpenClaw";
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
  document.addEventListener("click",event=>{const login=event.target.closest?.("#session-login");if(login)login.hash=location.hash});
  let timer,etag="",running=false,retryAt=0,following=false;
  const enabled=()=>document.querySelector("main[data-public-refresh='true']")!==null;
  const transcript=()=>document.querySelector(".transcript");
  const controls=document.querySelector(".reader-controls");
  const status=key=>{for(const node of document.querySelectorAll("[data-public-refresh-status]")){node.dataset.publicI18n=key;node.textContent=t(key)}};
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
    if(controls)controls.hidden=!transcript();
    const top=document.querySelector("[data-public-top]");
    if(top)top.disabled=window.scrollY<100;
  }
  window.addEventListener("scroll",()=>{following=enabled()&&atLatest();updateControls()},{passive:true});
  // Lazy images and font/layout changes must not leave a live follower behind.
  const observer=typeof ResizeObserver==="undefined"?null:new ResizeObserver(()=>{if(following&&!document.hidden)scrollLatest()});
  function observeTranscript(){observer?.disconnect();const node=transcript();if(node)observer?.observe(node);updateControls()}
  following=enabled()&&atLatest();
  observeTranscript();
  const jitter=()=>Math.floor(Math.random()*3000);
  const schedule=(delay=15000+jitter())=>{clearTimeout(timer);if(!document.hidden&&enabled())timer=setTimeout(refresh,Math.max(delay,retryAt-Date.now()))};
  document.addEventListener("click",event=>{
    if(event.target.closest?.("[data-public-top]")){following=false;window.scrollTo({top:0,behavior:"instant"});updateControls()}
    if(event.target.closest?.("[data-public-latest]")){following=enabled();scrollLatest();updateControls()}
    if(event.target.closest?.("[data-public-refresh-now]")&&enabled()&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();schedule(0)}
  });
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
      const main=next.querySelector("main[data-public-session]");
      const current=document.querySelector("main[data-public-session]");
      if(document.hidden||!current)return;
      if(!main){
        // Legacy token links return a plain 404 rather than a reader document.
        if(response.status===404){current.textContent=t("revoked");current.dataset.publicRefresh="false";document.title=t("unavailableTitle")+" · OpenClaw";observer?.disconnect();updateControls();return}
        throw new Error("Refresh failed");
      }
      const y=window.scrollY;
      const rows=[...current.querySelectorAll("[data-public-item]")];
      const anchor=rows.find(row=>{const bounds=row.getBoundingClientRect();return bounds.bottom>0&&bounds.top<window.innerHeight});
      const anchorTop=anchor?.getBoundingClientRect().top;
      const expanded=new Set([...current.querySelectorAll("details[open][data-public-item]")].map(row=>row.dataset.publicItem));
      for(const row of main.querySelectorAll("details[data-public-item]"))row.open=expanded.has(row.dataset.publicItem);
      current.replaceWith(main);
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
export const PUBLIC_SESSION_CONTENT_SECURITY_POLICY = `default-src 'none'; img-src 'self'; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'sha256-${ENTRY_SCRIPT_HASH}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;

const MAX_ITEMS = 51;
const MAX_MESSAGE_CHARS = 32_768;
const MAX_DOCUMENT_CHARS = 262_144;

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
markdown.validateLink = (value) => {
  const url = URL.parse(value);
  return Boolean(
    url &&
    (url.protocol === "https:" || url.protocol === "http:") &&
    !url.username &&
    !url.password,
  );
};
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

const PUBLIC_SESSION_PITCH_HTML = `<section class="colophon" aria-labelledby="openclaw-pitch"><div class="fleuron" aria-hidden="true">${LOBSTER_MARK}</div><p class="kicker">${copyMarkup("madeWith")}</p><h2 id="openclaw-pitch">${copyMarkup("pitchTitle")}</h2><p>${copyMarkup("pitchBody")}</p><div class="code install"><pre><code>curl -fsSL https://openclaw.ai/install.sh | bash</code></pre></div><p class="links"><a class="button primary" href="https://docs.openclaw.ai/start/getting-started" rel="noreferrer noopener">${copyMarkup("getStarted")} <span aria-hidden="true">→</span></a><a href="https://docs.openclaw.ai/start/why-openclaw" rel="noreferrer noopener">${copyMarkup("whyOpenClaw")}</a><a href="https://github.com/openclaw/openclaw" rel="noreferrer noopener">GitHub</a></p></section>`;

// Tokens and element styles mirror the Control UI's built-in themes and chat text
// (ui/src/styles/base.css, chat/text.css). Instrument Sans is the
// Gateway-hosted Control UI face, linked from the same mount.
const PUBLIC_SESSION_STYLES = `:root{color-scheme:dark;--bg:#0e1015;--bg-muted:#1f2330;--bg-elevated:#191c24;--hover:#1f2330;--panel:#191c24;--text:#bcbcc0;--text-strong:#f4f4f5;--muted:#8b8b94;--border:#1e2028;--border-strong:#2e3040;--accent:#ff5c5c;--bubble:rgba(255,92,92,.1);--bubble-ink:var(--text);--primary:#d13c3c;--primary-hover:#c22e2e;--link:color-mix(in srgb,#ff7070 85%,#bcbcc0);--ok:#69bf8a;--shell-light:#ff6d5a;--shell-dark:#c2372b;--eye:#050810;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-family:"Instrument Sans",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);font-synthesis:none;-webkit-font-smoothing:antialiased}
@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#faf9f7;--bg-muted:#efebe4;--bg-elevated:#fff;--hover:#efebe4;--panel:#f4f1ec;--text:#403c35;--text-strong:#211e1a;--muted:#6e6960;--border:#e8e4dc;--border-strong:#d6d0c5;--accent:#bd4531;--bubble:color-mix(in srgb,#bd4531 15%,#faf9f7);--bubble-ink:var(--text-strong);--primary:#bd4531;--primary-hover:#a83c29;--link:color-mix(in srgb,#a83c29 85%,#403c35);--ok:#2f9b5a;--shell-light:#ff4d4d;--shell-dark:#991b1b}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg)}a{color:var(--link);text-underline-offset:3px}a:hover{color:var(--text-strong)}a:focus-visible,.button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.defs{position:absolute;width:0;height:0;overflow:hidden}.mark .shell{fill:url(#openclaw-shell)}.mark .feeler{fill:none;stroke:var(--shell-light);stroke-width:3;stroke-linecap:round}.mark .eye{fill:var(--eye)}.mark .pupil{fill:#00e5cc}.shell-light{stop-color:var(--shell-light)}.shell-dark{stop-color:var(--shell-dark)}
.page{width:min(720px,calc(100% - 48px));margin:0 auto;padding:0 0 72px}.topbar{display:flex;align-items:center;justify-content:space-between;height:64px}.brand{display:inline-flex;align-items:center;gap:9px;color:var(--text-strong);font-size:15px;font-weight:650;letter-spacing:-.01em;text-decoration:none}.brand:hover{color:var(--text-strong)}.brand .mark{width:22px;height:22px}
.button{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border:1px solid var(--border);border-radius:10px;background:var(--bg-elevated);color:var(--text-strong);font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap;transition:background-color .12s ease-out,border-color .12s ease-out}.button:hover{background:var(--hover);border-color:var(--border-strong);color:var(--text-strong)}.button.primary{border-color:transparent;background:var(--primary);color:#fff}.button.primary:hover{background:var(--primary-hover);color:#fff}
.article-head{padding:56px 0 32px;margin-bottom:40px;border-bottom:1px solid var(--border)}.article-head:last-child{border-bottom:0}.eyebrow{display:flex;flex-wrap:wrap;align-items:center;gap:0 8px;margin:0 0 16px;color:var(--muted);font-size:13px;font-weight:500}.eyebrow .sep{color:var(--border-strong)}.live{display:inline-flex;align-items:center;gap:7px;color:var(--ok);font-weight:600}.live::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
h1{margin:0 0 16px;color:var(--text-strong);font-size:clamp(30px,5vw,40px);font-weight:650;line-height:1.12;letter-spacing:-.035em;overflow-wrap:anywhere;text-wrap:balance}.intro{max-width:600px;margin:0;color:var(--muted);font-size:14px;line-height:1.65}.intro strong{color:var(--text);font-weight:600}
.notice,.pagination{position:relative;margin:0 0 28px;color:var(--muted);font-size:13px;line-height:1.6}.notice{padding-inline-start:14px}.notice::before{content:"";position:absolute;top:3px;bottom:3px;inset-inline-start:0;width:3px;border-radius:9999px;background:var(--border-strong)}.pagination a{color:var(--muted);font-weight:500;text-decoration:none}.pagination a:hover{color:var(--text-strong)}.transcript+.pagination{margin:36px 0 0}
.tools{min-width:0;padding:10px 14px;border:1px solid var(--border);border-radius:10px;color:var(--muted);font-size:13px;overflow-wrap:anywhere}.tools summary{cursor:pointer;font-weight:600}.tools ul{margin:12px 0 0;padding-inline-start:20px}.tools li{margin:6px 0}.tools code{color:var(--text-strong);font-family:var(--mono)}.image{display:block;margin-top:12px}.image img{display:block;max-width:100%;height:auto;border-radius:8px}.attachment{display:inline-block;max-width:100%;margin:8px 8px 0 0;padding:4px 9px;border:1px solid var(--border-strong);border-radius:7px;font-size:13px;overflow-wrap:anywhere}
.transcript{display:flex;flex-direction:column;gap:28px}.message.continued{margin-top:-18px}.speaker{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.assistant{display:grid;grid-template-columns:28px minmax(0,1fr);gap:0 12px}.avatar{display:grid;place-items:center;width:28px;height:28px;margin-top:2px;border:1px solid var(--border);border-radius:50%;background:var(--panel)}.avatar .mark{width:17px;height:17px}.assistant .content{grid-column:2}
.user{display:flex;justify-content:flex-end}.user .content{max-width:min(78%,560px);padding:12px 16px;border-radius:10px;background:var(--bubble);color:var(--bubble-ink);font-size:15px}
.content{min-width:0;font-size:16px;line-height:1.65;overflow-wrap:anywhere}.content>:first-child{margin-top:0}.content>:last-child{margin-bottom:0}.content p,.content ul,.content ol,.content .code,.content blockquote,.content table{margin:0 0 .75em}.content strong{color:var(--text-strong);font-weight:650}.user .content strong{color:inherit}.content h1,.content h2,.content h3,.content h4{margin:1.4em 0 .5em;color:var(--text-strong);font-size:1.05em;line-height:1.4}.content ul,.content ol{padding-inline-start:1.4em}.content li{margin:.25em 0}.content li::marker{color:var(--muted)}
.content blockquote{position:relative;padding:4px 12px;color:var(--muted)}.content blockquote::before{content:"";position:absolute;top:4px;bottom:4px;inset-inline-start:0;width:3px;border-radius:9999px;background:var(--border-strong)}.content pre{margin:0;max-width:100%;overflow:auto;padding:10px 44px 10px 12px;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg-muted);font-size:13px;line-height:1.6}.content code{font-family:var(--mono);font-size:.88em}.content :not(pre)>code{padding:.1em .3em;border:1px solid var(--border-strong);border-radius:6px;background:var(--bg-muted);color:var(--text-strong)}.user .content :not(pre)>code{border-color:transparent;background:color-mix(in srgb,var(--bg) 55%,transparent);color:inherit}
.content table{display:block;width:max-content;max-width:100%;overflow:auto;border:1px solid color-mix(in srgb,var(--accent) 20%,var(--border));border-radius:8px;border-collapse:separate;border-spacing:0;font-size:14px}.content th,.content td{padding:8px 12px;border-bottom:1px solid var(--border);text-align:start}.content th{color:var(--text-strong);background:var(--bg-muted)}.content th:first-child{border-top-left-radius:7px}.content th:last-child{border-top-right-radius:7px}.content tr:last-child td{border-bottom:0}.content hr{margin:1.5em 0;border:0;border-top:1px solid var(--border)}.omitted,.empty{color:var(--muted);font-size:13px}.empty{margin:0;padding:8px 0 24px;font-size:14px;line-height:1.7}
.status{display:flex;justify-content:space-between;gap:24px;margin-top:48px;padding-top:20px;border-top:1px solid var(--border);color:var(--muted);font-size:12.5px;line-height:1.6}.status a{flex:none;color:var(--muted)}.status a:hover{color:var(--text-strong)}
.colophon{margin-top:72px}.fleuron{display:flex;align-items:center;gap:20px;margin-bottom:40px}.fleuron::before,.fleuron::after{content:"";flex:1;height:1px;background:var(--border)}.fleuron .mark{width:34px;height:34px}.kicker{margin:0 0 10px;color:var(--muted);font-size:13px;font-weight:600}.colophon h2{margin:0 0 14px;color:var(--text-strong);font-size:clamp(24px,3.6vw,30px);font-weight:650;line-height:1.18;letter-spacing:-.03em;text-wrap:balance}.colophon p{max-width:600px;margin:0;font-size:15.5px;line-height:1.65}
.install{margin:24px 0}.install pre{margin:0;padding:12px 48px 12px 16px;overflow:auto;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg-muted);color:var(--text-strong);font:13.5px/1.6 var(--mono)}.install pre::before{content:"$ ";color:var(--accent)}.install code{user-select:all}.links{display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px;font-size:14px;font-weight:500}.links a{color:var(--text);text-decoration:none}.links a:hover{color:var(--text-strong)}.links .button{padding:9px 16px;font-size:14px}
.code{position:relative;direction:ltr;text-align:left}.copy{position:absolute;top:6px;right:6px;display:grid;place-items:center;width:28px;height:28px;padding:0;border:1px solid var(--border-strong);border-radius:7px;background:var(--bg-elevated);color:var(--muted);cursor:pointer;opacity:0;transition:opacity .12s ease-out,color .12s ease-out}.copy svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.copy .done{display:none}.copy:hover{color:var(--text-strong)}.copy[data-copied],.copy[data-copied]:hover{color:var(--ok)}.copy[data-copied] svg{display:none}.copy[data-copied] .done{display:block}.code:hover .copy,.copy:focus-visible,.copy[data-copied],.install .copy{opacity:1}.install .copy{top:9px;right:9px}
@media(hover:none){.copy{opacity:1}}
.reader-controls{position:fixed;width:max-content;flex-wrap:wrap;justify-content:center;z-index:10;bottom:max(16px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;max-width:calc(100% - 24px);padding:8px;border:1px solid var(--border-strong);border-radius:14px;background:var(--bg-elevated);box-shadow:0 8px 28px #0003}.reader-controls button{font-family:inherit;cursor:pointer}.reader-controls .button:disabled{opacity:.45;cursor:default}.refresh-status{max-width:230px;padding:0 6px;color:var(--muted);font-size:12px;line-height:1.4}.page{padding-bottom:120px}@media(max-width:640px){.reader-controls{gap:6px}.reader-controls .button{padding:7px 10px}.refresh-status{max-width:100px;font-size:11px}}
.entry-status{display:none}[data-entry-pending] .entry-result{display:none}[data-entry-pending] .entry-status{display:block}[data-entry-pending] .login{visibility:hidden}
@media(min-width:840px){.assistant{grid-template-columns:minmax(0,1fr);margin-inline-start:-44px;padding-inline-start:44px}.avatar{position:absolute;margin-inline-start:-44px}.assistant .content{grid-column:1}}
@media(max-width:640px){.page{width:calc(100% - 36px)}.topbar{height:56px}.article-head{padding-top:36px;margin-bottom:32px}.user .content{max-width:88%}.content{font-size:15.5px}.install pre{white-space:pre-wrap;overflow-wrap:anywhere}.status{display:block}.status a{display:inline-block;margin-top:8px}}`;

export function publicSessionTitle(title: string): string {
  return (
    truncateUtf16Safe(stripInternalMetadataForDisplay(title), 200).trim() ||
    PUBLIC_SESSION_COPY.sharedConversation
  );
}

export function renderPublicSessionDocument(params: {
  messages: unknown[];
  mediaBaseUrl?: string;
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
        html: `<details class="tools"><summary>${copyMarkup(item.calls.length === 1 ? "toolOne" : "toolOther", item.calls.length)}</summary><ul>${lines.join("")}</ul>${lines.length < item.calls.length ? '<p class="omitted">' + copyMarkup("stepsOmitted") + "</p>" : ""}</details>`,
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
    if (entry.role === "tools") {
      return entry.html.replace(
        '<details class="tools"',
        `<details class="tools" data-public-item="${key}"`,
      );
    }
    const continued = ordered[index - 1]?.role === entry.role;
    return `<article class="message ${entry.role}${continued ? " continued" : ""}" data-public-item="${key}" ${copyLabel(entry.role === "user" ? "userMessage" : "assistantMessage")}><h2 class="speaker">${entry.role === "user" ? copyMarkup("user") : "OpenClaw"}</h2>${entry.role === "assistant" && !continued ? `<span class="avatar" aria-hidden="true">${LOBSTER_MARK}</span>` : ""}<div class="content" dir="auto">${entry.html}</div></article>`;
  });
  const description = params.unavailable
    ? "Log in to open conversations you have access to."
    : "A public, read-only OpenClaw conversation. No login required.";
  const canonicalMetadata = params.canonicalUrl
    ? `<link rel="canonical" href="${escapeHtml(params.canonicalUrl)}">
<meta property="og:url" content="${escapeHtml(params.canonicalUrl)}">`
    : "";
  const navigation = params.olderUrl
    ? `<nav class="pagination" ${copyLabel("conversationPages")}><a href="${escapeHtml(params.olderUrl)}" rel="prev"><span aria-hidden="true">←</span> ${copyMarkup("olderMessages")}</a></nav>`
    : "";
  const messageCount = entries.filter((entry) => entry.role !== "tools").length;
  const count = copyMarkup(messageCount === 1 ? "messageOne" : "messageOther", messageCount);
  const eyebrow = params.unavailable
    ? ""
    : isLatest
      ? `<p class="eyebrow"><span class="live">${copyMarkup("live")}</span><span class="sep">·</span>${copyMarkup("publicReadOnly")}<span class="sep">·</span>${count}</p>`
      : `<p class="eyebrow">${copyMarkup("earlierConversation")}<span class="sep">·</span>${count}<span class="sep">·</span><a href="${escapeHtml(params.latestUrl)}">${copyMarkup("backToLatest")}</a></p>`;
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
<style>
${PUBLIC_SESSION_STYLES}
</style>${entryPending ? "<noscript><style>[data-entry-pending] .entry-result{display:block}[data-entry-pending] .entry-status{display:none}[data-entry-pending] .login{visibility:visible}</style></noscript>" : ""}</head><body><main data-public-session${entryPending ? " data-entry-pending" : ""} data-public-refresh="${isLatest ? "true" : "false"}">
<svg class="defs" aria-hidden="true" focusable="false"><linearGradient id="openclaw-shell" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="shell-light"/><stop offset="1" class="shell-dark"/></linearGradient></svg>
<div class="page">
<header class="topbar"><a class="brand" href="https://openclaw.ai" rel="noreferrer noopener">${LOBSTER_MARK}<span>OpenClaw</span></a>${entryLink}</header>
<header class="article-head">${entryPending ? '<div class="entry-status" role="status"><h1>' + copyMarkup("loadingConversation") + '</h1><p class="intro">' + copyMarkup("checkingAccess") + '</p></div><div class="entry-result">' : ""}${eyebrow}<h1 dir="auto">${params.unavailable ? copyMarkup("unavailableTitle") : !stripInternalMetadataForDisplay(params.title).trim() ? copyMarkup("sharedConversation") : title}</h1><p class="intro">${
    params.unavailable
      ? copyMarkup("unavailable")
      : `<strong>${copyMarkup("sharedEveryone")}</strong> ${copyMarkup(isLatest ? "liveDescription" : "pageDescription")}${entryLink ? " " + copyMarkup("logInFull") : ""}`
  }</p>${entryPending ? "</div>" : ""}</header>
${truncated ? '<aside class="notice">' + copyMarkup("omittedHistory") + "</aside>" : ""}
${navigation}
${params.unavailable ? "" : `<section class="transcript" ${copyLabel("conversation")}>${rows.length ? rows.join("\n") : `<p class="empty">${copyMarkup(isLatest ? "emptyLive" : "emptyPage")}</p>`}</section>`}
${navigation}
${
  params.unavailable
    ? ""
    : `<footer class="status"><span>${copyMarkup(isLatest ? "liveFooter" : "earlierFooter")}<br>${copyMarkup("revocationNotice")}</span><a${isLatest ? " data-public-refresh-now" : ""} href="${escapeHtml(params.latestUrl)}">${copyMarkup(isLatest ? "refreshNow" : "backToLatest")}</a></footer>
${PUBLIC_SESSION_PITCH_HTML}`
}
</div>
</main>${params.unavailable ? "" : `<nav class="reader-controls" ${copyLabel("conversationNavigation")} hidden><span class="refresh-status" data-public-refresh-status role="status" data-public-i18n="${isLatest ? "liveUpdates" : "earlierMessages"}">${copyText(isLatest ? "liveUpdates" : "earlierMessages")}</span><button class="button" type="button" data-public-top ${copyLabel("goToTop")}><span aria-hidden="true">↑</span> ${copyMarkup("top")}</button><button class="button" type="button" data-public-latest ${copyLabel(isLatest ? "goToLatest" : "goToEnd")}><span aria-hidden="true">↓</span> ${copyMarkup(isLatest ? "latest" : "end")}</button>${isLatest ? `<a class="button" data-public-refresh-now href="${escapeHtml(params.latestUrl)}">${copyMarkup("refreshNow")}</a>` : ""}</nav>`}<script>${PUBLIC_SESSION_ENTRY_SCRIPT}</script></body></html>`;
}
