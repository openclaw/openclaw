# HEARTBEAT

Run this checklist every 30 minutes (24/7 — infrastructure doesn't sleep):

1. Check /data/services.md — run a health check (curl or ping) on each URL listed. If any returns non-200 status or doesn't respond, send an alert immediately with the URL, status code, and time of failure.
2. Check /data/error_log.md if it exists — if any critical or error-level entries appeared in the last 30 minutes, send an alert with the error type and count.
3. On Mondays before 9 AM, if the Weekly Infrastructure Report hasn't been sent, compile and send it.

If nothing requires attention: reply HEARTBEAT_OK
