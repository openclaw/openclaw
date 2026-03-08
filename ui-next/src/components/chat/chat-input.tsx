import {
  Square,
  RefreshCw,
  Paperclip,
  Mic,
  ArrowDown,
  ArrowUp,
  X,
  EyeOff,
  Wrench,
  Reply,
  Volume2,
  VolumeOff,
  Pause,
  Play,
  ListPlus,
} from "lucide-react";
import { useRef, useState, useCallback, useEffect } from "react";
import { AutocompleteMenu, useAutocomplete } from "@/components/chat/autocomplete-menu";
import { AnimatedPlaceholder } from "@/components/chat/chat-messages";
import { type ToolDisplayMode } from "@/components/chat/tool-call-card";
import { Button } from "@/components/ui/button";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
} from "@/components/ui/custom/prompt/input";
import { useToast } from "@/components/ui/custom/toast";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import {
  useChatStore,
  getMessageText,
  type ChatMessage,
  type DraftAttachment,
} from "@/store/chat-store";
import { useGatewayStore } from "@/store/gateway-store";

/** Stable empty array for zustand selector fallback (avoids infinite re-render). */
const EMPTY_ATTACHMENTS: DraftAttachment[] = [];

let attachmentIdCounter = 0;

/** Read a File as a base64 data URL string. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result as string));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

/** Extract the raw base64 data (without the data: prefix) from a data URL. */
function extractBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

// ─── Types ───

type TtsAutoMode = "off" | "always" | "inbound" | "tagged";
const TTS_MODES: TtsAutoMode[] = ["off", "always", "inbound", "tagged"];

type SttMode = "browser" | "server" | "none";
type SttState = "idle" | "listening" | "processing";

export type ChatInputProps = {
  inputValue: string;
  setInputValue: (valOrFn: string | ((prev: string) => string)) => void;
  placeholder: string;
  isStreaming: boolean;
  isPaused: boolean;
  sendMessage: (content: string | Array<unknown>) => Promise<void>;
  abortRun: () => Promise<void>;
  startQueue: () => void;
  stopQueue: () => void;
  toolDisplayMode: ToolDisplayMode;
  setToolDisplayMode: (
    mode: ToolDisplayMode | ((prev: ToolDisplayMode) => ToolDisplayMode),
  ) => void;
  /** Focus mode hides non-essential controls for distraction-free chat */
  focusMode?: boolean;
};

export function ChatInput({
  inputValue,
  setInputValue,
  placeholder,
  isStreaming,
  isPaused,
  sendMessage,
  abortRun,
  startQueue,
  stopQueue,
  toolDisplayMode,
  setToolDisplayMode,
  focusMode = false,
}: ChatInputProps) {
  const { sendRpc } = useGateway();
  const { toast } = useToast();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);
  const messages = useChatStore((s) => s.messages);
  const messageQueue = useChatStore((s) => s.messageQueue);
  const isQueueRunning = useChatStore((s) => s.isQueueRunning);

  // TTS auto mode
  const [ttsMode, setTtsMode] = useState<TtsAutoMode>("off");

  // STT state
  const [sttMode, setSttMode] = useState<SttMode>("none");
  const [sttState, setSttState] = useState<SttState>("idle");
  const [interimTranscript, setInterimTranscript] = useState("");
  const recognitionRef = useRef<unknown>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);

  // Reply-to state
  const [replyTo, setReplyTo] = useState<{ seq: number; role: string; preview: string } | null>(
    null,
  );

  // Attachment state from store
  const attachments = useChatStore(
    (s) => s.drafts[s.activeSessionKey]?.attachments ?? EMPTY_ATTACHMENTS,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Autocomplete for /, @, # triggers
  const autocomplete = useAutocomplete(inputValue, setInputValue);

  // Reset reply state when session changes
  useEffect(() => {
    setReplyTo(null);
  }, [activeSessionKey]);

  // Load TTS status on connect
  useEffect(() => {
    if (!isConnected) {
      return;
    }
    sendRpc<{ auto?: string }>("tts.status", {})
      .then((res) => {
        const mode = res?.auto as TtsAutoMode | undefined;
        if (mode && TTS_MODES.includes(mode)) {
          setTtsMode(mode);
        }
      })
      .catch(() => {});
  }, [isConnected, sendRpc]);

  // Detect STT availability
  useEffect(() => {
    if (!isConnected) {
      return;
    }
    sendRpc<{ available?: boolean }>("stt.status", {})
      .then((res) => {
        if (res?.available) {
          setSttMode("server");
          return;
        }
        const SR =
          (window as unknown as Record<string, unknown>).SpeechRecognition ||
          (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
        setSttMode(SR ? "browser" : "none");
      })
      .catch(() => {
        const SR =
          (window as unknown as Record<string, unknown>).SpeechRecognition ||
          (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
        setSttMode(SR ? "browser" : "none");
      });
  }, [isConnected, sendRpc]);

  // Cleanup STT on unmount
  useEffect(() => {
    return () => {
      (recognitionRef.current as { stop(): void } | null)?.stop();
      mediaRecorderRef.current?.stop();
    };
  }, []);

  // TTS playback: speak assistant responses when streaming ends
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (isStreaming) {
      wasStreamingRef.current = true;
      return;
    }
    if (!wasStreamingRef.current) {
      return;
    }
    wasStreamingRef.current = false;

    if (ttsMode === "off" || !window.speechSynthesis) {
      return;
    }

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") {
      return;
    }

    const text = getMessageText(lastMsg);
    if (!text.trim()) {
      return;
    }

    if (ttsMode === "tagged" && !text.includes("[[tts]]") && !text.includes("[[tts:")) {
      return;
    }

    const clean = text
      .replace(/\[\[tts(?::([^\]]*))?\]\]/g, "$1")
      .replace(/#{1,6}\s+/g, "")
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
      .replace(/`{1,3}[^`]*`{1,3}/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^[-*]\s+/gm, "")
      .replace(/\n{2,}/g, ". ")
      .trim();

    if (clean.length < 5) {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  }, [isStreaming, messages, ttsMode]);

  const toggleStt = useCallback(() => {
    if (sttMode === "none") {
      return;
    }

    if (sttState === "listening") {
      (recognitionRef.current as { stop(): void } | null)?.stop();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      setSttState("idle");
      setInterimTranscript("");
      return;
    }

    if (sttMode === "browser") {
      const SR =
        (window as unknown as Record<string, unknown>).SpeechRecognition ||
        (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
      if (!SR) {
        return;
      }

      const recognition = new (SR as new () => EventTarget & {
        continuous: boolean;
        interimResults: boolean;
        lang: string;
        onstart: (() => void) | null;
        onend: (() => void) | null;
        start(): void;
        stop(): void;
      })();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";

      recognition.onstart = () => {
        setSttState("listening");
      };

      recognition.addEventListener("result", (event: Event) => {
        const e = event;
        let interim = "";
        let finalText = "";

        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          if (result.isFinal) {
            finalText += result[0].transcript;
          } else {
            interim += result[0].transcript;
          }
        }

        if (finalText) {
          setInputValue((prev) => {
            const separator = prev.trim() ? " " : "";
            return prev + separator + finalText.trim();
          });
          setInterimTranscript("");
        } else {
          setInterimTranscript(interim);
        }
      });

      recognition.addEventListener("error", (event: Event) => {
        const e = event;
        console.error("Speech recognition error:", e.error);
        setSttState("idle");
        setInterimTranscript("");
        recognitionRef.current = null;
        switch (e.error) {
          case "not-allowed":
            toast("Microphone access denied", "error");
            break;
          case "network":
            sendRpc<{ available?: boolean }>("stt.status", {})
              .then((res) => {
                if (res?.available) {
                  setSttMode("server");
                  toast("Switched to server STT (browser speech service unreachable)", "success");
                } else {
                  toast(
                    "Browser speech service unreachable. Configure a server STT provider (whisper-cpp, openai, groq) as an alternative.",
                    "error",
                  );
                }
              })
              .catch(() => {
                toast("Browser speech service unreachable", "error");
              });
            break;
          case "audio-capture":
            toast("No microphone detected", "error");
            break;
          case "service-not-allowed":
            toast("Speech recognition service not available", "error");
            break;
          case "aborted":
            break;
          default:
            toast("Speech recognition failed", "error");
        }
      });

      recognition.onend = () => {
        setSttState("idle");
        setInterimTranscript("");
        recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      recognition.start();
    } else if (sttMode === "server") {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm";
          const recorder = new MediaRecorder(stream, { mimeType });
          mediaChunksRef.current = [];

          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              mediaChunksRef.current.push(e.data);
            }
          };

          recorder.onstop = async () => {
            stream.getTracks().forEach((t) => t.stop());
            const blob = new Blob(mediaChunksRef.current, { type: mimeType });
            mediaChunksRef.current = [];
            if (blob.size === 0) {
              setSttState("idle");
              return;
            }
            setSttState("processing");
            setInterimTranscript("Transcribing...");
            try {
              const arrayBuf = await blob.arrayBuffer();
              const base64 = btoa(
                new Uint8Array(arrayBuf).reduce(
                  (data, byte) => data + String.fromCharCode(byte),
                  "",
                ),
              );
              const res = await sendRpc<{ text?: string }>("stt.transcribe", {
                audio: base64,
                mime: mimeType.split(";")[0],
              });
              const text = res?.text?.trim();
              if (text) {
                setInputValue((prev) => {
                  const separator = prev.trim() ? " " : "";
                  return prev + separator + text;
                });
              }
            } catch (err) {
              console.error("STT transcription failed:", err);
              toast("Transcription failed", "error");
            } finally {
              setSttState("idle");
              setInterimTranscript("");
              mediaRecorderRef.current = null;
            }
          };

          recorder.addEventListener("error", () => {
            stream.getTracks().forEach((t) => t.stop());
            setSttState("idle");
            setInterimTranscript("");
            mediaRecorderRef.current = null;
            toast("Recording failed", "error");
          });

          mediaRecorderRef.current = recorder;
          recorder.start();
          setSttState("listening");
          setInterimTranscript("Recording...");
        })
        .catch((err) => {
          console.error("Mic access error:", err);
          if (err.name === "NotAllowedError") {
            toast("Microphone access denied", "error");
          } else {
            toast("Could not access microphone", "error");
          }
        });
    }
  }, [sttMode, sttState, setInputValue, sendRpc, toast]);

  const cycleTtsMode = useCallback(() => {
    const nextIdx = (TTS_MODES.indexOf(ttsMode) + 1) % TTS_MODES.length;
    const next = TTS_MODES[nextIdx];
    setTtsMode(next);
    window.speechSynthesis?.cancel();
    sendRpc("config.patch", { messages: { tts: { auto: next } } }).catch(() => {});
  }, [ttsMode, sendRpc]);

  const handleReply = useCallback(
    (msg: ChatMessage) => {
      const msgText = getMessageText(msg);
      const lines = msgText.split("\n").slice(0, 2);
      let preview = lines.join("\n");
      if (preview.length > 150) {
        preview = preview.slice(0, 150) + "\u2026";
      } else if (msgText.split("\n").length > 2) {
        preview += "\u2026";
      }

      setReplyTo({ seq: msg.seq, role: msg.role, preview });

      const quoteBlock = `> [Re: #${msg.seq}] ${preview}\n\n`;
      setInputValue((prev) => {
        const stripped = prev.replace(/^> \[Re: #\d+\][\s\S]*?\n\n/, "");
        return quoteBlock + stripped;
      });

      setTimeout(() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 0);
    },
    [setInputValue],
  );

  const clearReply = useCallback(() => {
    setReplyTo(null);
    setInputValue((prev) => prev.replace(/^> \[Re: #\d+\][\s\S]*?\n\n/, ""));
  }, [setInputValue]);

  const addAttachments = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    const newAttachments: DraftAttachment[] = [];
    for (const file of imageFiles) {
      const preview = await readFileAsDataUrl(file);
      newAttachments.push({
        id: `att-${++attachmentIdCounter}`,
        preview,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
      });
    }
    const store = useChatStore.getState();
    const key = store.activeSessionKey;
    const prev = store.drafts[key]?.attachments ?? [];
    store.setDraftAttachments(key, [...prev, ...newAttachments]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    const store = useChatStore.getState();
    const key = store.activeSessionKey;
    const prev = store.drafts[key]?.attachments ?? [];
    store.setDraftAttachments(
      key,
      prev.filter((a) => a.id !== id),
    );
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) {
        return;
      }
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            imageFiles.push(file);
          }
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        void addAttachments(imageFiles);
      }
    },
    [addAttachments],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) {
        return;
      }
      void addAttachments(Array.from(files));
      e.target.value = "";
    },
    [addAttachments],
  );

  const handleSubmit = async () => {
    const hasText = inputValue.trim().length > 0;
    const hasAttachments = attachments.length > 0;
    if ((!hasText && !hasAttachments) || isStreaming) {
      return;
    }

    try {
      if (hasAttachments) {
        const contentBlocks: Array<unknown> = [];
        if (hasText) {
          contentBlocks.push({ type: "text", text: inputValue });
        }
        for (const att of attachments) {
          const base64 = extractBase64(att.preview);
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: att.fileType,
              data: base64,
            },
          });
        }
        await sendMessage(contentBlocks);
      } else {
        await sendMessage(inputValue);
      }
      useChatStore.getState().clearDraft(activeSessionKey);
      setReplyTo(null);
    } catch {
      toast("Failed to send message", "error");
    }
  };

  // Expose handleReply for the parent page to pass to message bubbles
  // We use a ref-stable callback pattern via the exported hook
  return (
    <div className="shrink-0 p-4 pt-2 pb-6 z-20 bg-gradient-to-t from-background via-background to-transparent">
      <div className="mx-auto max-w-4xl relative">
        {/* Session status bar */}
        <div className="absolute -top-7 left-1/2 -translate-x-1/2 flex items-center gap-2 text-[10px] font-mono text-muted-foreground/60 hover:text-muted-foreground transition-colors duration-300">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              isConnected ? "bg-primary animate-glow-pulse" : "bg-destructive",
            )}
          />
          <span>{isConnected ? "Connected" : "Disconnected"}</span>
        </div>

        {/* Hidden file input for Paperclip button */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        {/* Queue Panel */}
        {messageQueue.length > 0 && (
          <div className="mb-2 rounded-xl border border-border/60 bg-card/60 backdrop-blur-sm overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40 bg-muted/30">
              <span className="text-[11px] font-mono text-muted-foreground">
                Queue ({messageQueue.length})
              </span>
              <div className="flex items-center gap-1">
                {isQueueRunning ? (
                  <button
                    onClick={stopQueue}
                    className="text-[10px] px-2 py-0.5 rounded-md bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors font-medium"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={startQueue}
                    disabled={!isConnected}
                    className="text-[10px] px-2 py-0.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors font-medium disabled:opacity-40"
                  >
                    Run All
                  </button>
                )}
                <button
                  onClick={() => useChatStore.getState().clearQueue()}
                  className="text-[10px] px-2 py-0.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="max-h-32 overflow-y-auto">
              {messageQueue.map((item, i) => (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 text-xs group",
                    item.status === "sending" && "bg-primary/5",
                    i < messageQueue.length - 1 && "border-b border-border/20",
                  )}
                >
                  <span className="text-[10px] font-mono text-muted-foreground/60 w-4 shrink-0 text-center">
                    {item.status === "sending" ? (
                      <RefreshCw className="h-3 w-3 animate-spin text-primary" />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span className="flex-1 truncate text-foreground/80">
                    {typeof item.content === "string" ? item.content : "[multimodal]"}
                  </span>
                  {i > 0 && item.status !== "sending" && (
                    <button
                      onClick={() => useChatStore.getState().reorderQueue(i, i - 1)}
                      className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5"
                      title="Move up"
                    >
                      <ArrowUp className="h-3 w-3" />
                    </button>
                  )}
                  {i < messageQueue.length - 1 && item.status !== "sending" && (
                    <button
                      onClick={() => useChatStore.getState().reorderQueue(i, i + 1)}
                      className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5"
                      title="Move down"
                    >
                      <ArrowDown className="h-3 w-3" />
                    </button>
                  )}
                  {item.status !== "sending" && (
                    <button
                      onClick={() => useChatStore.getState().removeFromQueue(item.id)}
                      className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 text-destructive"
                      title="Remove"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Autocomplete dropdown — positioned above the input */}
        <AutocompleteMenu
          isOpen={autocomplete.isOpen}
          triggerMode={autocomplete.triggerMode}
          items={autocomplete.filteredItems}
          selectedIndex={autocomplete.selectedIndex}
          loading={autocomplete.loading}
          onSelect={autocomplete.selectItem}
        />

        <PromptInput
          value={inputValue}
          onValueChange={(v) => {
            setInputValue(v);
            // Trigger autocomplete detection on controlled value changes
            autocomplete.handleInputChange(v);
          }}
          onSubmit={handleSubmit}
          isLoading={isStreaming}
          className="bg-secondary/40 border-border/60 shadow-lg backdrop-blur-md rounded-3xl ring-1 ring-border/40 focus-within:ring-primary/20 transition-all p-0"
        >
          {/* Reply-to preview chip */}
          {replyTo && (
            <div className="flex items-center gap-2 px-4 pt-3 pb-1">
              <div className="flex items-center gap-2 bg-muted/50 border border-border/50 rounded-lg px-3 py-1.5 text-xs font-mono text-muted-foreground max-w-full min-w-0">
                <Reply className="h-3 w-3 shrink-0 text-primary" />
                <span className="shrink-0 text-primary font-medium">#{replyTo.seq}</span>
                <span className="truncate">{replyTo.preview}</span>
                <button
                  onClick={clearReply}
                  className="shrink-0 ml-1 hover:text-foreground transition-colors"
                  aria-label="Dismiss reply"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}

          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div className="flex items-center gap-2 px-4 pt-3 pb-1 overflow-x-auto">
              {attachments.map((att) => (
                <div key={att.id} className="relative shrink-0 group/att">
                  <img
                    src={att.preview}
                    alt={att.fileName}
                    className="h-12 w-12 rounded-lg object-cover border border-border/60"
                  />
                  <button
                    onClick={() => removeAttachment(att.id)}
                    className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-background border border-border flex items-center justify-center opacity-0 group-hover/att:opacity-100 transition-opacity shadow-sm hover:bg-destructive hover:text-destructive-foreground hover:border-destructive"
                    aria-label="Remove attachment"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {interimTranscript && sttState === "listening" && (
            <div className="px-4 pb-1">
              <div className="text-xs text-muted-foreground/70 italic font-mono truncate">
                {interimTranscript}
              </div>
            </div>
          )}

          <div
            onPaste={handlePaste}
            className="relative"
            onKeyDownCapture={(e) => {
              // Intercept keyboard events for autocomplete before the
              // textarea's own Enter-to-submit handler fires.
              if (autocomplete.handleKeyDown(e)) {
                e.stopPropagation();
              }
            }}
          >
            <PromptInputTextarea
              disabled={!isConnected}
              className="text-base min-h-[56px] px-4 py-4 md:text-sm"
            />
            {/* Animated placeholder overlay */}
            {!inputValue && (
              <div
                className="absolute inset-0 pointer-events-none flex items-start px-4 py-4"
                aria-hidden
              >
                <AnimatedPlaceholder text={placeholder} isStreaming={isStreaming} />
              </div>
            )}
          </div>

          {/* Internal Toolbar */}
          <div className="flex items-center justify-between px-3 pb-3 pt-1">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-xs"
                className="h-8 w-8 text-muted-foreground hover:bg-muted/50 rounded-lg hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
                title="Attach image"
                aria-label="Attach image"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              {/* Tool display mode toggle — hidden in focus mode */}
              <div className={cn(
                "transition-all duration-200",
                focusMode ? "opacity-0 w-0 overflow-hidden pointer-events-none" : "opacity-100",
              )}>
                <button
                  onClick={() =>
                    setToolDisplayMode((prev) =>
                      prev === "collapsed"
                        ? "expanded"
                        : prev === "expanded"
                          ? "hidden"
                          : "collapsed",
                    )
                  }
                  className={cn(
                    "flex items-center gap-1 px-2 h-8 text-xs font-mono rounded-lg hover:bg-muted/50 transition-colors cursor-pointer",
                    toolDisplayMode === "hidden"
                      ? "text-muted-foreground/40"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  title={`Tool display: ${toolDisplayMode}`}
                >
                  {toolDisplayMode === "hidden" ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Wrench className="h-3.5 w-3.5" />
                  )}
                  <span className="hidden sm:inline">
                    {toolDisplayMode === "collapsed"
                      ? "Tools"
                      : toolDisplayMode === "expanded"
                        ? "Expanded"
                        : "Hidden"}
                  </span>
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* STT / TTS / Queue — hidden in focus mode */}
              <div className={cn(
                "flex items-center gap-2 transition-all duration-200",
                focusMode ? "opacity-0 w-0 overflow-hidden pointer-events-none" : "opacity-100",
              )}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    "h-8 w-8 rounded-full transition-all",
                    sttState === "listening"
                      ? "text-red-500 bg-red-500/10 hover:bg-red-500/20 animate-pulse"
                      : sttState === "processing"
                        ? "text-yellow-500 bg-yellow-500/10 cursor-wait"
                        : sttMode === "none"
                          ? "text-muted-foreground/40 cursor-not-allowed"
                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                  onClick={toggleStt}
                  disabled={sttMode === "none" || sttState === "processing"}
                  aria-label={
                    sttState === "listening"
                      ? "Stop listening"
                      : sttState === "processing"
                        ? "Transcribing..."
                        : "Voice input"
                  }
                  title={
                    sttMode === "none"
                      ? "Speech recognition not available"
                      : sttState === "listening" || sttState === "processing"
                        ? "Click to stop"
                        : `Voice input (${sttMode === "server" ? "server STT" : "browser"})`
                  }
                >
                  <Mic className="h-4 w-4" />
                </Button>
                <button
                  onClick={cycleTtsMode}
                  className={cn(
                    "flex items-center gap-1 px-2 h-8 text-xs font-mono rounded-full transition-colors cursor-pointer",
                    ttsMode === "off"
                      ? "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                      : "text-primary hover:bg-primary/10",
                  )}
                  title={`TTS: ${ttsMode}`}
                  aria-label={`Text-to-speech: ${ttsMode}`}
                >
                  {ttsMode === "off" ? (
                    <VolumeOff className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                  {ttsMode !== "off" && (
                    <span className="hidden sm:inline text-[10px]">{ttsMode}</span>
                  )}
                </button>
              </div>
              <PromptInputActions>
                <div className="flex items-center gap-1">
                  {/* Queue button — hidden in focus mode */}
                  {!focusMode && (
                    <button
                      onClick={() => {
                        const content = inputValue.trim();
                        if (!content) {
                          return;
                        }
                        useChatStore.getState().enqueueMessage(content);
                        setInputValue("");
                      }}
                      disabled={!inputValue.trim() && attachments.length === 0}
                      aria-label={
                        messageQueue.length > 0 ? `Queue (${messageQueue.length})` : "Add to queue"
                      }
                      title={
                        messageQueue.length > 0 ? `${messageQueue.length} in queue` : "Add to queue"
                      }
                      className={cn(
                        "relative h-8 w-8 rounded-full flex items-center justify-center shadow-md transition-all duration-200",
                        inputValue.trim()
                          ? "bg-sky-600 text-white transform hover:scale-105 hover:bg-sky-500"
                          : "bg-sky-600/15 text-sky-400/30 border border-sky-600/20",
                      )}
                    >
                      <ListPlus className="h-4 w-4" />
                      {messageQueue.length > 0 && (
                        <span className="absolute -top-1 -right-1 h-4 min-w-4 px-0.5 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center shadow-sm">
                          {messageQueue.length}
                        </span>
                      )}
                    </button>
                  )}

                  {/* Streaming controls: pause/resume + stop */}
                  {isStreaming && (
                    <>
                      <button
                        onClick={() => {
                          const store = useChatStore.getState();
                          if (store.isPaused) {
                            store.resumeStream();
                          } else {
                            store.pauseStream();
                          }
                        }}
                        aria-label={isPaused ? "Resume output" : "Pause output"}
                        title={isPaused ? "Resume output" : "Pause output"}
                        className={cn(
                          "h-8 w-8 rounded-full flex items-center justify-center shadow-md transition-all transform hover:scale-105",
                          isPaused
                            ? "bg-amber-500 text-white hover:bg-amber-400"
                            : "bg-amber-500/80 text-white hover:bg-amber-500",
                        )}
                      >
                        {isPaused ? (
                          <Play className="h-3.5 w-3.5 fill-current" />
                        ) : (
                          <Pause className="h-3.5 w-3.5 fill-current" />
                        )}
                      </button>
                      <button
                        onClick={abortRun}
                        aria-label="Stop generating"
                        title="Stop generating"
                        className="h-8 w-8 rounded-full flex items-center justify-center bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-md transform hover:scale-105 transition-all"
                      >
                        <Square className="h-3.5 w-3.5 fill-current" />
                      </button>
                    </>
                  )}

                  {/* Send button */}
                  {!isStreaming && (
                    <button
                      onClick={handleSubmit}
                      disabled={(!inputValue.trim() && attachments.length === 0) || !isConnected}
                      aria-label="Send message"
                      title="Send message"
                      className={cn(
                        "h-8 w-8 rounded-full flex items-center justify-center shadow-md transition-all duration-200",
                        inputValue.trim() || attachments.length > 0
                          ? "bg-primary text-primary-foreground transform hover:scale-105"
                          : "bg-primary/15 text-primary/30 border border-primary/20",
                      )}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </PromptInputActions>
            </div>
          </div>
        </PromptInput>

        <div className="text-center mt-2 text-[10px] text-muted-foreground/40 font-mono">
          AI Operator can make mistakes. Please verify important information.
        </div>
      </div>
    </div>
  );
}

// Re-export handleReply for use by the parent page
export { type ChatMessage };
