# HEARTBEAT

Run this checklist every 30 minutes during active hours (8 AM – 8 PM):

1. Check /data/metrics.md — if any metric has a defined threshold, compare the latest recorded value to that threshold. If any threshold is breached, send an alert with the metric name, current value, threshold, and severity.
2. On Fridays after 4 PM, if the Weekly Business Report hasn't been sent yet, compile and send it.
3. If /data/metrics.md doesn't exist yet, remind the principal to share their key KPIs and thresholds.

If nothing requires attention: reply HEARTBEAT_OK
