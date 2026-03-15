                  <span className={`px-2 py-1 rounded text-xs font-bold ${openclawStatus.gateway.state === 'running' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
                    {openclawStatus.gateway.state.toUpperCase()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Port</span>
                  <span className="font-mono">{openclawStatus.gateway.port}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Agents</span>
                  <span>{openclawStatus.agents.active} / {openclawStatus.agents.total} active</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Status</span>
                  <span className={openclawStatus.status === 'ok' ? 'text-green-400' : 'text-red-400'}>
                    {openclawStatus.status.toUpperCase()}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-gray-500">Loading OpenClaw status...</p>
            )}
          </div>

          {/* Agent Stats */}
          <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 border border-gray-700">
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
              <span>👥</span> Agent Overview
            </h2>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-gray-400">Total Agents</span>
                <span className="text-2xl font-bold">{totalAgents}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-400">Active</span>
                <span className="text-2xl font-bold text-green-400">{onlineCount}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-400">Inactive</span>
                <span className="text-2xl font-bold text-gray-400">{totalAgents - onlineCount}</span>
              </div>
              <div className="pt-4 border-t border-gray-700">
                <div className="text-sm text-gray-400 mb-2">Connection Status</div>
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${status === 'connected' ? 'bg-green-500' : status === 'connecting' ? 'bg-yellow-500' : 'bg-red-500'}`}></div>
                  <span className="capitalize">{status}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Active Agents */}
        <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 border border-gray-700 mb-8">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <span>🚀</span> Active Agents
            </h2>
            <div className="text-sm text-gray-400">
              Showing {onlineCount} of {totalAgents} agents
            </div>
          </div>
          
          {agents.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No agents available</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {agents
                .filter(agent => agent.status === 'online' || agent.status === 'busy')
                .map(agent => (
                  <div key={agent.id} className="bg-gray-900/50 rounded-lg p-4 border border-gray-700 hover:border-gray-600 transition-colors">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="text-2xl">{agent.emoji}</div>
                      <div>
                        <div className="font-bold">{agent.name}</div>
                        <div className="text-sm text-gray-400">{agent.role}</div>
                      </div>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-400">Status</span>
                      <span className={`px-2 py-1 rounded text-xs font-bold ${agent.status === 'online' ? 'bg-green-900/30 text-green-400' : agent.status === 'busy' ? 'bg-yellow-900/30 text-yellow-400' : 'bg-gray-900/30 text-gray-400'}`}>
                        {agent.status?.toUpperCase() || 'UNKNOWN'}
                      </span>
                    </div>
                    <div className="flex justify-between items-center mt-2">
                      <span className="text-sm text-gray-400">ID</span>
                      <span className="text-xs font-mono text-gray-400">{agent.id}</span>
                    </div>
                  </div>
                ))}
              
              {agents.filter(a => a.status === 'online' || a.status === 'busy').length === 0 && (
                <div className="col-span-full text-center py-8">
                  <div className="text-4xl mb-4">😴</div>
                  <p className="text-gray-400">No active agents</p>
                  <p className="text-sm text-gray-500 mt-2">Connect to OpenClaw to see agent status</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Cron Jobs */}
        <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 border border-gray-700">
          <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
            <span>⏰</span> Scheduled Tasks
          </h2>
          
          {cronJobs.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No cron jobs configured</p>
          ) : (
            <div className="space-y-4">
              {cronJobs.map((job, index) => (
                <div key={index} className="flex items-center justify-between p-4 bg-gray-900/30 rounded-lg border border-gray-700">
                  <div className="flex items-center gap-4">
                    <div className={`w-3 h-3 rounded-full ${job.enabled ? 'bg-green-500' : 'bg-gray-500'}`}></div>
                    <div>
                      <div className="font-bold">{job.name}</div>
                      <div className="text-sm text-gray-400 font-mono">{job.schedule}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm text-gray-400">
                      {job.lastRun ? `Last run: ${new Date(job.lastRun).toLocaleTimeString()}` : 'Never run'}
                    </div>
                    <div className={`text-xs px-2 py-1 rounded ${job.enabled ? 'bg-green-900/30 text-green-400' : 'bg-gray-900/30 text-gray-400'}`}>
                      {job.enabled ? 'ENABLED' : 'DISABLED'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-800 py-6 px-6 mt-8">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center">
          <div className="mb-4 md:mb-0">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-gradient-to-r from-purple-600 to-blue-500 rounded"></div>
              <span className="font-bold">OKO MISSION CONTROL</span>
            </div>
            <p className="text-sm text-gray-400 mt-1">Real OpenClaw integration with agency-agents</p>
          </div>
          
          <div className="text-sm text-gray-400">
            <div className="flex items-center gap-4">
              <span>Gateway: {status === 'connected' ? '✅ Connected' : '❌ Disconnected'}</span>
              <span>•</span>
              <span>Agents: {onlineCount}/{totalAgents}</span>
              <span>•</span>
              <span>Updated: {lastUpdate.toLocaleTimeString()}</span>
            </div>
            <div className="text-xs text-gray-500 mt-2">
              PWA Ready • Install as app • Real-time updates
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}