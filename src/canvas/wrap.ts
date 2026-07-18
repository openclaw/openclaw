function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

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
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;"><title>${escapeHtml(title)}</title><style>:root{color-scheme:light dark}*{box-sizing:border-box}html,body{margin:0}body{font:14px system-ui,sans-serif}.svg-widget{display:grid;place-items:center}.svg-widget>svg{max-width:100%}</style></head><body${bodyClass}>${promptBridge}${widgetCode}${sizeReporter}</body></html>`;
}
