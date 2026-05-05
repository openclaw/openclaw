FROM node:22-slim

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY index.js clusterer.js work-resolver.js verify-overlay.js ./

CMD ["node", "index.js"]
