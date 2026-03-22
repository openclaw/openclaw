# HEARTBEAT

Run this checklist every 30 minutes during market hours (6 AM – 5 PM on trading days):

1. Check /data/watchlist.md — fetch latest prices for all listed tickers. If any ticker has moved more than 3% intraday, send an alert with the ticker, move percentage, and most likely reason based on recent news.
2. Before 8 AM on trading days, if the Morning Market Brief hasn't been sent yet, compile and send it.
3. If /data/watchlist.md doesn't exist yet, remind the principal to share their first watchlist tickers and investment time horizon.

If nothing requires attention: reply HEARTBEAT_OK
