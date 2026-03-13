import { Check, Copy } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { codeToHtml } from "shiki";
import { cn } from "@/lib/utils";

export type CodeBlockProps = {
  children?: React.ReactNode;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <div
      className={cn(
        "not-prose group/code relative flex w-full flex-col overflow-clip border",
        "border-border bg-card text-card-foreground rounded-xl",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type CodeBlockCodeProps = {
  code: string;
  language?: string;
  theme?: string;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }, [code]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "absolute right-2 top-2 z-10 rounded-md border border-border/60 bg-card/80 p-1.5",
        "opacity-0 backdrop-blur transition-all group-hover/code:opacity-100",
        "hover:bg-muted text-muted-foreground hover:text-foreground",
        copied && "opacity-100 text-green-400 hover:text-green-400",
      )}
      title={copied ? "Copied!" : "Copy code"}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

// T6: language badge — shown top-left, opposite the copy button
function LanguageBadge({ language }: { language: string }) {
  if (!language || ["plaintext", "text", ""].includes(language)) {
    return null;
  }
  return (
    <span className="absolute left-3 top-2 z-10 font-mono text-[10px] uppercase tracking-wide text-muted-foreground/40 select-none pointer-events-none">
      {language}
    </span>
  );
}

function CodeBlockCode({
  code,
  language = "tsx",
  theme = "vitesse-dark",
  className,
  ...props
}: CodeBlockCodeProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  useEffect(() => {
    async function highlight() {
      if (!code) {
        setHighlightedHtml("<pre><code></code></pre>");
        return;
      }
      const html = await codeToHtml(code, { lang: language, theme });
      setHighlightedHtml(html);
    }
    void highlight();
  }, [code, language, theme]);

  const classNames = cn(
    "w-full overflow-x-auto text-[13px] [&>pre]:px-4 [&>pre]:py-4 [&>pre]:min-w-full",
    // leave room for the language badge on the left
    language && !["plaintext", "text", ""].includes(language ?? "") && "[&>pre]:pt-7",
    className,
  );

  return (
    <>
      <LanguageBadge language={language ?? ""} />
      {code && <CopyButton code={code} />}
      {highlightedHtml ? (
        <div
          className={classNames}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          {...props}
        />
      ) : (
        <div className={classNames} {...props}>
          <pre>
            <code>{code}</code>
          </pre>
        </div>
      )}
    </>
  );
}

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>;

function CodeBlockGroup({ children, className, ...props }: CodeBlockGroupProps) {
  return (
    <div className={cn("flex items-center justify-between", className)} {...props}>
      {children}
    </div>
  );
}

// ── T7: dark/light mode hook for mermaid theme sync ──────────────────────────

function useDarkMode(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
    obs.observe(document.documentElement, { attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

// ── Mermaid render queue — serializes renders to avoid mermaid singleton races ─
// Mermaid is a global singleton; concurrent render() calls corrupt shared state.

let mermaidRenderQueue: Promise<void> = Promise.resolve();

function cleanupMermaidOrphans(id: string) {
  // Mermaid v11 injects temp SVG + error elements directly into document.body
  document.getElementById(id)?.remove();
  document.getElementById(`d${id}`)?.remove();
  // Sweep any orphan mermaid error/render containers left in body
  for (const el of document.querySelectorAll("body > [id^='mermaid-'], body > [id^='dmermaid-']")) {
    el.remove();
  }
}

// ── Mermaid diagram renderer (T7: theme sync + zoom) ─────────────────────────

function MermaidBlock({ code }: { code: string }) {
  const [svgContent, setSvgContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const isDark = useDarkMode();

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${Math.random().toString(36).slice(2)}`;

    // Queue this render behind any in-flight renders to avoid singleton races
    mermaidRenderQueue = mermaidRenderQueue.then(async () => {
      if (cancelled || !code.trim()) {
        return;
      }
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? "dark" : "default",
          securityLevel: "loose",
        });
        const { svg } = await mermaid.render(id, code.trim());
        if (!cancelled) {
          setSvgContent(svg);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
        }
      } finally {
        cleanupMermaidOrphans(id);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [code, isDark]); // re-render when dark mode changes

  if (error) {
    return (
      <CodeBlock>
        <CodeBlockCode code={code} language="text" />
      </CodeBlock>
    );
  }

  if (!svgContent) {
    // Loading skeleton
    return <div className="my-4 h-20 rounded-xl border border-border bg-card animate-pulse" />;
  }

  return (
    <>
      {/* Diagram preview — click to zoom */}
      <div
        className="my-4 flex justify-center overflow-x-auto rounded-xl border border-border bg-card p-4 [&>svg]:max-w-full cursor-zoom-in"
        dangerouslySetInnerHTML={{ __html: svgContent }}
        onClick={() => setZoomed(true)}
        title="Click to zoom"
      />

      {/* Zoom modal overlay */}
      {zoomed && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setZoomed(false)}
        >
          <div
            className="bg-card rounded-xl border border-border p-8 max-w-[92vw] max-h-[92vh] overflow-auto cursor-default [&>svg]:max-w-full [&>svg]:h-auto"
            dangerouslySetInnerHTML={{ __html: svgContent }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

export { CodeBlockGroup, CodeBlockCode, CodeBlock, MermaidBlock };
