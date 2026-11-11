FROM node:24.22.1-bookworm
# pnpm 10 initializes its store before resolving dependencies; reproduce that
# supported custom-image path independently of pnpm 12's project-local store.
RUN npm install -g pnpm@10.23.0 --ignore-scripts && useradd --no-create-home --uid 1001 sandbox
ENV HOME=/home/sandbox
USER sandbox
WORKDIR /workspace
CMD ["sleep", "infinity"]
