export type MeetingSoxAudioFormat = {
  sampleRate: number;
  channels: number;
  encoding: string;
  bits: number;
  endian?: "little" | "big";
};

export type MeetingSoxAudioCommandParams = {
  bufferBytes: number;
  device?: string;
  deviceType?: string;
  format: MeetingSoxAudioFormat;
  inputExecutable?: string;
  outputExecutable?: string;
};

function formatArgs(format: MeetingSoxAudioFormat): string[] {
  return [
    "-t",
    "raw",
    "-r",
    String(format.sampleRate),
    "-c",
    String(format.channels),
    "-e",
    format.encoding,
    "-b",
    String(format.bits),
    ...(format.endian === "little" ? ["-L"] : format.endian === "big" ? ["-B"] : []),
    "-",
  ];
}

function withBuffer(executable: string, bufferBytes: number, args: string[]): string[] {
  return [executable, "-q", "--buffer", String(bufferBytes), ...args];
}

export function buildMeetingSoxAudioCommands(params: MeetingSoxAudioCommandParams): {
  inputCommand: string[];
  outputCommand: string[];
} {
  const wire = formatArgs(params.format);
  const device = params.device ? ["-t", params.deviceType ?? "coreaudio", params.device] : [];
  return {
    inputCommand: withBuffer(
      params.inputExecutable ?? (params.device ? "sox" : "rec"),
      params.bufferBytes,
      [...device, ...wire],
    ),
    outputCommand: withBuffer(
      params.outputExecutable ?? (params.device ? "sox" : "play"),
      params.bufferBytes,
      [...wire, ...device],
    ),
  };
}
