import type { createTranscriptCaptureAppends } from "./capture-appends.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptSourceLocator,
  TranscriptSourceProvider,
} from "./provider-types.js";
import type { TranscriptsSummary } from "./summary.js";

type TranscriptCaptureSummary = {
  summary: TranscriptsSummary;
  intendedSummaryPath: string;
};

export type ActiveTranscriptsSession = {
  appends: ReturnType<typeof createTranscriptCaptureAppends>;
  directCapture?: { stateDir: string; drain: () => Promise<void> };
  abortStartup?: () => void;
  providerStopping?: Promise<string | undefined>;
  session: TranscriptSessionDescriptor;
  providerId: string;
  // Cleanup belongs to the admitted provider, even after registry replacement.
  stopProvider: NonNullable<TranscriptSourceProvider["stop"]>;
  releaseProvider: () => Promise<void>;
  // Diagnostic request identity, never authority. URLs retain presence only, not invitations.
  configuredSource?: Readonly<
    Pick<TranscriptSourceLocator, "providerId" | "accountId" | "guildId" | "channelId"> & {
      meetingUrl: boolean;
    }
  >;
  // Durable timestamps can collide; lifecycle cleanup must match this exact process-owned capture.
  lifecycleToken?: symbol;
  // Keep the capture reserved until provider and durable stop work both finish.
  stopping?: true;
  // Failed cleanup stays owned and cannot append until a later stop succeeds.
  cleanupPending?: true;
  phase: "starting" | "active" | "terminal" | "failed";
  summaryUpdates?: { start(): void; stop(): Promise<void> };
  finalization?: {
    persisted: Promise<TranscriptCaptureSummary>;
    released: Promise<TranscriptCaptureSummary>;
  };
};
