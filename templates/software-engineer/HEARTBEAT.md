# HEARTBEAT

Run this checklist every 30 minutes during active hours (9 AM – 9 PM):

1. Check if there is a test suite in the current project. If yes, run it. If any tests are failing, send the failing test names and error messages.
2. Check git log for any uncommitted changes older than 24 hours. If found, send a reminder with the files changed.
3. Check /data/issues.md if it exists — if any issue is marked HIGH priority and has been open for more than 48 hours, send an escalation notice.

If nothing requires attention: reply HEARTBEAT_OK
