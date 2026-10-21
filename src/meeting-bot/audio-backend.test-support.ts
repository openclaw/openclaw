export function createPulseCommands(loaded = false) {
  const devices = { sinks: loaded, sources: loaded };
  return ([command, action, ...args]: string[]) => {
    let stdout = "";
    if (command === "/bin/sh") {
      return { status: 0, stdout, stderr: "" };
    }
    if (command !== "pactl") {
      return { status: 1, stdout, stderr: `unexpected command: ${command}` };
    }
    if (action === "info") {
      stdout = "Server Name: PulseAudio (on PipeWire)";
    } else if (action === "load-module") {
      devices.sinks ||= args[0] === "module-null-sink";
      devices.sources ||= args[0] === "module-remap-source";
      stdout = "17";
    } else if (action === "list" && (args[1] === "sinks" || args[1] === "sources")) {
      const kind = args[1];
      const id = kind === "sinks" ? 42 : 43;
      stdout = devices[kind] ? `${id}\topenclaw_meeting_audio\tPipeWire\ts16le\tSUSPENDED` : "";
    }
    return { status: 0, stdout, stderr: "" };
  };
}
