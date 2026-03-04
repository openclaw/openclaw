export default function OverviewPage() {
  return (
    <div style={{ animation: "rise 0.3s ease-out" }}>
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.025em",
            color: "var(--text-strong)",
            margin: 0,
          }}
        >
          Overview
        </h1>
        <p style={{ color: "var(--muted)", marginTop: 6, marginBottom: 0 }}>
          Gateway status and activity at a glance.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 14,
          marginBottom: 24,
        }}
      >
        {[
          { label: "Status", value: "Online", color: "var(--ok)" },
          { label: "Messages Today", value: "—" },
          { label: "Active Agents", value: "—" },
          { label: "Channels", value: "—" },
        ].map((stat) => (
          <div
            key={stat.label}
            style={{
              background: "var(--card)",
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: "var(--border)",
              borderRadius: "var(--radius-md)",
              padding: "14px 16px",
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: "var(--muted)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {stat.label}
            </div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                marginTop: 6,
                letterSpacing: "-0.02em",
                color: stat.color ?? "var(--text-strong)",
              }}
            >
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          background: "var(--card)",
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: "var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: 20,
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--text-strong)",
            marginBottom: 4,
          }}
        >
          Gateway
        </div>
        <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
          Connect to your OpenClaw gateway to see live status here.
        </p>
      </div>
    </div>
  );
}
