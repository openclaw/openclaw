function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const WIDGET_THEME_TOKENS = [
  "surface",
  "card",
  "elevated",
  "text",
  "text-strong",
  "muted",
  "border",
  "border-strong",
  "accent",
  "accent-fg",
  "ok",
  "warn",
  "danger",
  "info",
  "radius",
  "font-body",
  "font-mono",
] as const;

// Baked palettes mirror the host claw theme (ui/src/styles/base.css) so
// fallback renders match Control UI renders, where the theme bridge pushes the
// same host values. Contrast tradeoffs in these pairings are owned by the host
// theme; do not diverge here.
const WIDGET_BASE_STYLES = `:root{color-scheme:light dark;
--surface:#faf9f7;--card:#ffffff;--elevated:#ffffff;
--text:#403c35;--text-strong:#211e1a;--muted:#6e6960;
--border:#e8e4dc;--border-strong:#d6d0c5;
--accent:#bd4531;--accent-fg:#ffffff;
--ok:#15803d;--warn:#b45309;--danger:#dc2626;--info:#2563eb;
--radius:10px;
--font-body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
--font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--accent-subtle:color-mix(in srgb,var(--accent) 10%,transparent);
--ok-subtle:color-mix(in srgb,var(--ok) 10%,transparent);
--warn-subtle:color-mix(in srgb,var(--warn) 12%,transparent);
--danger-subtle:color-mix(in srgb,var(--danger) 10%,transparent);
--info-subtle:color-mix(in srgb,var(--info) 10%,transparent)}
@media (prefers-color-scheme:dark){:root{
--surface:#0e1015;--card:#161920;--elevated:#191c24;
--text:#d4d4d8;--text-strong:#f4f4f5;--muted:#8b8b94;
--border:#1e2028;--border-strong:#2e3040;
--accent:#ff5c5c;--accent-fg:#fafafa;
--ok:#22c55e;--warn:#f59e0b;--danger:#ef4444;--info:#3b82f6}}
*{box-sizing:border-box}html,body{margin:0}
body{font:14px/1.5 var(--font-body);color:var(--text)}
h1,h2,h3{margin:0 0 8px;color:var(--text-strong);font-weight:600}
h1{font-size:18px}h2{font-size:16px}h3{font-size:14px}
p{margin:0 0 8px}
a{color:var(--accent)}
button{font:13px var(--font-body);color:var(--text);background:var(--card);border:1px solid var(--border-strong);border-radius:var(--radius);padding:6px 14px;cursor:pointer}
button:hover{border-color:var(--muted)}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:transparent}
input,select,textarea{font:13px var(--font-body);color:var(--text);background:var(--elevated);border:1px solid var(--border-strong);border-radius:var(--radius);padding:6px 10px}
input:focus,select:focus,textarea:focus,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:4px 8px}
td{padding:6px 8px;border-top:1px solid var(--border)}
code,pre{font-family:var(--font-mono);font-size:12px;background:var(--card);border-radius:4px}
code{padding:1px 5px}pre{padding:10px;overflow-x:auto}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px}
.badge{display:inline-block;font-size:12px;padding:2px 10px;border-radius:999px;background:var(--accent-subtle);color:var(--accent)}
.badge.ok{background:var(--ok-subtle);color:var(--ok)}
.badge.warn{background:var(--warn-subtle);color:var(--warn)}
.badge.danger{background:var(--danger-subtle);color:var(--danger)}
.badge.info{background:var(--info-subtle);color:var(--info)}
.metric{font-size:24px;font-weight:600;color:var(--text-strong)}
.muted{color:var(--muted)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.svg-widget{display:grid;place-items:center}.svg-widget>svg{max-width:100%}`;

/** Wraps agent-authored widget markup in the stable isolated Canvas document shell. */
export function buildWidgetDocument(title: string, widgetCode: string): string {
  const isSvg = /^<svg/i.test(widgetCode);
  const bodyClass = isSvg ? ' class="svg-widget"' : "";
  // Inline scripts may drive the widget; CSP blocks resource loads, while preview metadata
  // prevents the iframe from inheriting same-origin access to the parent application.
  // The size reporter lets the embedding chat fit the iframe to the content; the
  // parent clamps reported heights, so widget code cannot abuse the channel.
  const sizeReporter =
    "<script>(()=>{if(!window.parent||window.parent===window)return;" +
    // documentElement.scrollHeight reports the viewport for short content, so
    // measure the body box, which tracks the actual widget height.
    "let last=0;const report=()=>{const b=document.body;if(!b)return;" +
    "const h=Math.ceil(Math.max(b.scrollHeight,b.offsetHeight,b.getBoundingClientRect().height));" +
    'if(h&&h!==last){last=h;window.parent.postMessage({type:"openclaw:widget-size",height:h},"*");}};' +
    "addEventListener('load',report);new ResizeObserver(report).observe(document.body);" +
    "setTimeout(report,50);setTimeout(report,500);})();</script>";
  // The prompt bridge precedes widget code so inline handlers can reference
  // sendPrompt() immediately. It creates the prompt channel itself and offers
  // one endpoint to the embedding chat at parse time — before any widget code
  // can run, steal the endpoint, or navigate the frame — so the chat's
  // first-offer-wins adoption is always bound to this document. The send
  // endpoint stays private to this closure, and sendPrompt requires transient
  // user activation, so widget code cannot auto-send without a real user
  // gesture; the chat additionally validates, requires a focused visible
  // frame, and rate limits every prompt.
  // Everything sendPrompt later touches is snapshotted here, before widget
  // code exists, so prototype patches (MessagePort.postMessage, the
  // userActivation getter) by widget code cannot leak the endpoint or fake a
  // gesture. Fail closed: no observable transient user activation, no send.
  const promptBridge =
    "<script>(()=>{if(!window.parent||window.parent===window)return;" +
    "const c=new MessageChannel();" +
    "const post=c.port1.postMessage.bind(c.port1);" +
    "let act=null;" +
    "try{const ua=navigator.userActivation;" +
    'const d=ua&&Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ua),"isActive");' +
    "if(d&&d.get)act=d.get.bind(ua);}catch{}" +
    'window.parent.postMessage({type:"openclaw:widget-prompt-offer"},"*",[c.port2]);' +
    "window.sendPrompt=text=>{if(!act||act()!==true)return;" +
    'post({type:"openclaw:widget-prompt",prompt:String(text)});};})();</script>';
  /*
   * The host may push a new theme after every theme change. Each message is a
   * full snapshot: omitted or invalid tokens are removed so a theme switch
   * falls back to the baked palette instead of keeping stale inline values.
   * Only the fixed widget token allowlist crosses the frame boundary, and the
   * native style setters are captured before widget code can patch them.
   */
  const themeBridge =
    "<script>(()=>{if(!window.parent||window.parent===window)return;" +
    "const root=document.documentElement;const set=root.style.setProperty.bind(root.style);" +
    "const rm=root.style.removeProperty.bind(root.style);" +
    `const keys=${JSON.stringify(WIDGET_THEME_TOKENS)};` +
    'addEventListener("message",event=>{if(event.source!==window.parent)return;' +
    'const data=event.data;if(!data||data.type!=="openclaw:widget-theme"||' +
    'typeof data.tokens!=="object"||data.tokens===null)return;' +
    "for(const key of keys){const raw=data.tokens[key];" +
    'const value=typeof raw==="string"?raw.trim():"";' +
    'if(value&&value.length<=256)set("--"+key,value);else rm("--"+key);}' +
    'if(data.mode==="light"||data.mode==="dark")set("color-scheme",data.mode);});})();</script>';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;"><title>${escapeHtml(title)}</title><style>${WIDGET_BASE_STYLES}</style></head><body${bodyClass}>${promptBridge}${themeBridge}${widgetCode}${sizeReporter}</body></html>`;
}
