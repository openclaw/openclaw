import { type JSX } from "preact";
import { useState, useEffect } from "preact/hooks";
import { debugConnection, type DebugLogEntry } from "./debug-connection";

interface DebugDrawerProps {
  onClose: () => void;
}

export function DebugDrawer({ onClose }: DebugDrawerProps): JSX.Element {
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<string>("");

  useEffect(() => {
    const unsubscribe = debugConnection.subscribe((newLogs) => {
      setLogs(newLogs);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (autoScroll) {
      const container = document.getElementById("debug-drawer-logs");
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }, [logs, autoScroll]);

  const filteredLogs = filter
    ? logs.filter(
        (log) =>
          log.message.toLowerCase().includes(filter.toLowerCase()) ||
          log.type.toLowerCase().includes(filter.toLowerCase())
      )
    : logs;

  const handleCopy = () => {
    const text = debugConnection.exportLogs();
    navigator.clipboard.writeText(text);
  };

  const handleClear = () => {
    debugConnection.clear();
  };

  const getLevelColor = (level: string): string => {
    switch (level) {
      case "error":
        return "#f85149";
      case "warn":
        return "#d29922";
      case "debug":
        return "#8b949e";
      default:
        return "#58a6ff";
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        width: "500px",
        height: "100vh",
        background: "#161b22",
        borderLeft: "1px solid #30363d",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        fontFamily: "monospace",
        fontSize: "12px",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #30363d",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "#21262d",
        }}
      >
        <span style={{ color: "#58a6ff", fontWeight: "bold" }}>🔧 Debug Logs</span>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "#8b949e",
            cursor: "pointer",
            fontSize: "16px",
          }}
        >
          ✕
        </button>
      </div>

      {/* Controls */}
      <div
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid #30363d",
          display: "flex",
          gap: "8px",
          flexWrap: "wrap",
        }}
      >
        <input
          type="text"
          placeholder="Filter logs..."
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          style={{
            flex: 1,
            minWidth: "120px",
            padding: "4px 8px",
            background: "#0d1117",
            border: "1px solid #30363d",
            borderRadius: "4px",
            color: "#c9d1d9",
            fontSize: "11px",
          }}
        />
        <button
          onClick={handleCopy}
          style={{
            padding: "4px 8px",
            background: "#238636",
            border: "none",
            borderRadius: "4px",
            color: "#fff",
            cursor: "pointer",
            fontSize: "11px",
          }}
        >
          Copy
        </button>
        <button
          onClick={handleClear}
          style={{
            padding: "4px 8px",
            background: "#da3633",
            border: "none",
            borderRadius: "4px",
            color: "#fff",
            cursor: "pointer",
            fontSize: "11px",
          }}
        >
          Clear
        </button>
        <label style={{ display: "flex", alignItems: "center", gap: "4px", color: "#8b949e" }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll((e.target as HTMLInputElement).checked)}
          />
          Auto-scroll
        </label>
      </div>

      {/* Log count */}
      <div style={{ padding: "4px 16px", borderBottom: "1px solid #30363d", color: "#8b949e" }}>
        {filteredLogs.length} / {logs.length} entries
      </div>

      {/* Logs */}
      <div
        id="debug-drawer-logs"
        style={{
          flex: 1,
          overflow: "auto",
          padding: "8px 0",
        }}
      >
        {filteredLogs.length === 0 ? (
          <div style={{ padding: "16px", color: "#8b949e", textAlign: "center" }}>
            No logs yet. Enable debug mode to start capturing.
          </div>
        ) : (
          filteredLogs.map((log, index) => (
            <div
              key={index}
              style={{
                padding: "4px 16px",
                borderBottom: "1px solid #21262d",
                color: getLevelColor(log.level),
              }}
            >
              <span style={{ color: "#6e7681" }}>
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>{" "}
              <span style={{ fontWeight: "bold" }}>[{log.type}]</span> {log.message}
              {log.data && (
                <pre
                  style={{
                    margin: "4px 0 0 0",
                    padding: "4px",
                    background: "#0d1117",
                    borderRadius: "4px",
                    fontSize: "10px",
                    overflow: "auto",
                    maxHeight: "100px",
                  }}
                >
                  {JSON.stringify(log.data, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
