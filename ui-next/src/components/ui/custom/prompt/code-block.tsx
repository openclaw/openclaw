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
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    });
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
    highlight();
  }, [code, language, theme]);

  const classNames = cn(
    "w-full overflow-x-auto text-[13px] [&>pre]:px-4 [&>pre]:py-4 [&>pre]:min-w-full",
    className,
  );

  return (
    <>
      {code && <CopyButton code={code} />}
      {highlightedHtml ? (
        <div className={classNames} dangerouslySetInnerHTML={{ __html: highlightedHtml }} {...props} />
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

export { CodeBlockGroup, CodeBlockCode, CodeBlock };
